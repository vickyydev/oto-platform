import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BoxAgent } from '@oto/box-agent';
import {
  account,
  band,
  box,
  boxState,
  child,
  member,
  paymentAttempt,
  product,
  refund,
  sale,
  session as sessionTable,
  station,
  ticketPackage,
  visit,
  voucherRedemption,
} from '@oto/db';
import { BOX_LANE_REFUSALS, mintBoothCode, newId, verifyBandCode } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-295 — THE OFFLINE CAPABILITY LIST, ONE CASE PER ROW.
 *
 * Plan `docs/progress/plans/offline/PLAN.md` §2.8 is the list; `ARCHITECTURE.md`
 * §17 publishes it; this file enforces it (register Check 7). Every row gets a
 * case that runs its operation with the station offline and asserts the row:
 *
 *   - a REFUSAL row is asserted in the platform's own words — the answer a
 *     till gets for it with its station offline — and again on the box lane,
 *     in the capability list's own reasons (`BOX_LANE_REFUSALS`);
 *   - a WORKS row is asserted through the box: rounds 3 and 4 built every one
 *     (plan §4), and each is driven through the station bridge with the
 *     station forced offline and the box's link cut;
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
  { operation: 'Unlock a locked till', offline: 'Works' },
  { operation: 'Fresh sign-in', offline: 'Works, bounded' },
  { operation: 'Find a member by phone', offline: 'Works' },
  { operation: 'Create a member; add or edit a child; confirm who is visiting', offline: 'Works' },
  { operation: 'Ticket, F&B and shop pricing', offline: 'Works, bounded' },
  { operation: 'Promo code', offline: 'Works' },
  { operation: 'Manual discount, ฿0 comp, tier change', offline: 'Works' },
  { operation: 'Cash', offline: 'Works' },
  { operation: 'Card on the terminal', offline: 'Works' },
  { operation: 'PAX (Digio) QR', offline: 'Works, flagged' },
  { operation: '2C2P QR', offline: 'Refused' },
  { operation: 'Gift or prize voucher', offline: 'Refused' },
  { operation: 'Wallet spend', offline: 'Refused' },
  { operation: 'Online booking redemption', offline: 'Refused' },
  { operation: 'Refund, void', offline: 'Refused; a "refund requested" note queues' },
  { operation: 'Receipt and bands for an offline sale', offline: 'Works' },
  { operation: 'Reprint', offline: 'Works for today\'s sales on this box' },
  { operation: 'Customer display', offline: 'Works' },
  { operation: 'History, Today, reports', offline: 'Refused politely' },
  { operation: 'Child check-in and release', offline: 'Rides this bridge in S2-13', pending: 'S2-13, not this cluster' },
];

/** The platform's words for a station that is offline — the answer a till gets. */
const OFFLINE_REFUSAL = {
  code: 'STATION_FORCED_OFFLINE',
  message:
    'This station is forced offline for testing. Go online before taking payment or changing the sale.',
};

/**
 * A voucher is not a payment, so the generic "go online before taking payment"
 * sentence is the wrong thing to say (offline finding 6). Same refusal code —
 * the till's lane arbiter reads it — spoken in the voice the refund path uses,
 * and spoken platform-side so every till says it identically.
 */
const VOUCHER_OFFLINE_REFUSAL = {
  code: 'STATION_FORCED_OFFLINE',
  message:
    'Online only — a voucher is checked by the platform, so redeem it when the station is back online.',
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

  const expectRefusedOffline = (
    res: { statusCode: number; json: () => unknown; headers: Record<string, unknown> },
    expected: { code: string; message: string } = OFFLINE_REFUSAL,
  ) => {
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: unknown }).error).toEqual(expected);
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
    // The voucher path speaks its own offline sentence, not the payment one.
    expectRefusedOffline(await call('GET', '/vouchers/lookup?code=OFFLINE-VOUCHER'), VOUCHER_OFFLINE_REFUSAL);
    expectRefusedOffline(
      await call('POST', `/sales/${saleId}/vouchers`, { code: 'OFFLINE-VOUCHER' }),
      VOUCHER_OFFLINE_REFUSAL,
    );
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

/**
 * ROUND 3'S ROWS, THROUGH THE BOX (plan §4, SCRUM-269).
 *
 * The same station forced offline as the refusals above, so the platform's own
 * trading routes answer `503 STATION_FORCED_OFFLINE` — and the till's lane
 * arbiter moves to the station bridge, which answers from the box's copies.
 * The box is the virtual box's agent (`createBoxAgent`), running in this
 * process as it does on staging, with its link to the platform cut.
 */
describe('what works offline works through the box (plan §4, Rounds 3 and 4)', () => {
  let ctx: TestContext;
  let cookie: string;
  let adminCookie: string;
  let tillId: string;
  let branchId: string;
  let token: { token: string; jti: string };
  let accountId: string;
  let agent: BoxAgent;
  const link: CuttableLink = { cut: false };
  const keys = generateKeyPairSync('ed25519');

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    as: string | null,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
    const res = await ctx.app.inject({
      method,
      url,
      headers: { ...(as ? { cookie: as } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  };
  const bridge = (rest: string) => `/box/v1/station/${tillId}/${rest}`;
  const intent = (type: string, payload: Record<string, unknown>) => ({
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `cap-${newId()}`,
  });
  /** The station forced offline, and the box's link to the platform cut with it. */
  const goOffline = async (): Promise<void> => {
    await agent.setOffline(true, { reason: 'capability list, round 3' });
    link.cut = true;
  };
  const goOnline = async (): Promise<void> => {
    link.cut = false;
    await agent.setOffline(false);
  };

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        OPS_TEST_CONTROLS: 'true',
        STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
    });
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const box1 = await boxBySlot(ctx.db, 'virtual-1');
    const [till] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
    tillId = till!.id;
    branchId = till!.branchId;
    const picked = await call('PUT', '/me/session/station', cookie, { stationId: tillId });
    expect(picked.statusCode).toBe(200);
    token = picked.body.staffToken as { token: string; jti: string };
    const [staff] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, RECEPTION.phone));
    accountId = staff!.id;
    agent = linkedAgent(ctx, box1.id, 'capability-box', link, { devices: true });
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    await agent.syncCache();
    attachInProcessBox(agent);
    await goOffline();
  }, 180_000);

  afterAll(async () => {
    agent?.stop();
    if (agent) detachInProcessBox(agent);
    await ctx.close();
    await teardownAll();
  });

  it(`Unlock a locked till — ${byOperation('Unlock a locked till').offline.toLowerCase()}: token and password against the box's copy`, async () => {
    expect((await call('POST', '/auth/lock', cookie)).statusCode).toBe(200);
    const res = await call('POST', bridge('unlock'), cookie, {
      token: token.token,
      password: RECEPTION.password,
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.method).toBe('offline_token');
    expect((await call('GET', '/me', cookie)).body.sessionLocked).toBe(false);
  });

  it(`Fresh sign-in — ${byOperation('Fresh sign-in').offline.toLowerCase()}: seen here in 30 days, with a deny-list under 72 hours`, async () => {
    const opened = await agent.bridge()!.unlock(tillId, { password: RECEPTION.password, accountId });
    expect(opened.response).toMatchObject({ method: 'offline_sign_in', offlineFresh: true });
  });

  it(`Find a member by phone — ${byOperation('Find a member by phone').offline.toLowerCase()}: from the members cache`, async () => {
    const refused = await call('GET', '/members/lookup?phone=0811111111', cookie);
    expect(refused.statusCode).toBe(503);
    const res = await call('GET', bridge('members/lookup?phone=0811111111'), cookie);
    expect(res.statusCode).toBe(200);
    const found = res.body.member as { phone: string; children: unknown[]; source: string };
    expect(found.phone).toBe('+66811111111');
    expect(found.children.length).toBeGreaterThan(0);
    expect(found.source).toBe('cache');
  });

  it('Create a member; add or edit a child; confirm who is visiting — works offline, and reaches the platform once', async () => {
    const memberId = newId();
    const childId = newId();
    const visitId = newId();
    const phone = '+66899991234';
    const steps: Array<[string, Record<string, unknown>]> = [
      ['member.create', { memberId, phone, nickname: 'Offline family' }],
      ['child.create', { childId, memberId, name: 'Pim', ageYears: 5 }],
      ['child.update', { childId, allergies: 'Shellfish' }],
      ['visit.create', { visitId, memberId, childIds: [childId] }],
    ];
    for (const [type, payload] of steps) {
      const res = await call('POST', bridge('intents'), cookie, intent(type, payload));
      expect(res.statusCode, `${type}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    expect(await ctx.db.select().from(member).where(eq(member.id, memberId))).toEqual([]);
    await goOnline();
    await agent.outbox()!.flush();
    const [kept] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(kept?.phone).toBe(phone);
    const [kid] = await ctx.db.select().from(child).where(eq(child.id, childId));
    expect(kid?.allergies).toBe('Shellfish');
    expect(await ctx.db.select().from(visit).where(eq(visit.id, visitId))).toHaveLength(1);
    await goOffline();
  });

  it(`Ticket, F&B and shop pricing — ${byOperation('Ticket, F&B and shop pricing').offline.toLowerCase()}: the box's figure is the platform's`, async () => {
    const [pkg] = await ctx.db
      .select({ id: ticketPackage.id })
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
    // A menu item with no required question, and a shop item in one size.
    const food = await ctx.db.execute<{ id: string }>(sql`
      select p.id from pos.product p
       where p.kind = 'menu' and p.active and p.archived_at is null
         and (p.branch_id is null or p.branch_id = ${branchId})
         and not exists (select 1 from pos.modifier_group g
                          where g.product_id = p.id and g.required and g.archived_at is null)
         and not exists (select 1 from pos.product_modifier_group l
                          join pos.modifier_group g on g.id = l.modifier_group_id
                          where l.product_id = p.id and g.required and g.archived_at is null)
       order by p.name limit 1`);
    const [shop] = await ctx.db
      .select({ id: product.id })
      .from(product)
      .where(
        and(
          eq(product.kind, 'merch'),
          eq(product.active, true),
          sql`jsonb_array_length(${product.variants}) < 2`,
          sql`${product.archivedAt} is null`,
          sql`(${product.branchId} is null or ${product.branchId} = ${branchId})`,
        ),
      )
      .limit(1);
    const foodId = food.rows[0]?.id;
    const cart = {
      lines: [{ id: newId(), packageId: pkg!.id, kids: 2, adults: 1 }],
      items: [
        ...(foodId ? [{ id: newId(), productId: foodId, quantity: 2 }] : []),
        ...(shop ? [{ id: newId(), productId: shop.id, quantity: 1 }] : []),
      ],
    };
    expect(cart.items.length, 'the seed carries a menu item and a shop item to price').toBe(2);
    // The platform's figure, asked while it is up.
    await goOnline();
    const online = await call('POST', '/sales/quote', cookie, { stationId: tillId, ...cart });
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
    await goOffline();
    expect((await call('POST', '/sales/quote', cookie, { stationId: tillId, ...cart })).statusCode).toBe(503);
    const offline = await call('POST', bridge('intents'), cookie, intent('cart.quote', cart));
    expect(offline.statusCode, JSON.stringify(offline.body)).toBe(200);
    const boxQuote = (
      offline.body.result as { quote: { totals: unknown; lineTotals: unknown; catalogueState: string } }
    ).quote;
    const platformQuote = online.body.quote as { totals: unknown; lineTotals: unknown };
    expect(boxQuote.totals).toEqual(platformQuote.totals);
    expect(boxQuote.lineTotals).toEqual(platformQuote.lineTotals);
    expect(boxQuote.catalogueState).toBe('fresh');
  });

  it(`Promo code — ${byOperation('Promo code').offline.toLowerCase()}: the till's copy is applied on the box`, async () => {
    const [pkg] = await ctx.db
      .select({ id: ticketPackage.id })
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
    const res = await call(
      'POST',
      bridge('intents'),
      cookie,
      intent('cart.quote', {
        lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 0 }],
        promos: [{ code: 'TILLCOPY10', label: 'Ten per cent', type: 'percent', value: 10 }],
      }),
    );
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const quote = (
      res.body.result as { quote: { appliedPromos: Array<{ code: string; amountSatang: number }> } }
    ).quote;
    expect(quote.appliedPromos).toEqual([expect.objectContaining({ code: 'TILLCOPY10' })]);
    expect(quote.appliedPromos[0]!.amountSatang).toBeGreaterThan(0);
  });

  it(`Customer display — ${byOperation('Customer display').offline.toLowerCase()}: it follows the box with its own credential`, async () => {
    const bearer = 'cd'.repeat(32);
    await goOnline();
    const minted = await call('POST', '/display/pairing', null, {}, { authorization: `Bearer ${bearer}` });
    expect(minted.statusCode).toBe(200);
    const claimed = await call(
      'POST',
      `/stations/${tillId}/displays/claim`,
      adminCookie,
      { pairingCode: minted.body.pairingCode, name: 'Capability display' },
      { 'idempotency-key': newId() },
    );
    expect(claimed.statusCode, JSON.stringify(claimed.body)).toBe(200);
    await agent.syncCache();
    await goOffline();
    const read = await call('GET', bridge('display/session'), null, undefined, {
      authorization: `Bearer ${bearer}`,
    });
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect((read.body.document as { stationId: string }).stationId).toBe(tillId);
    // On a Pi the box holds only the credential's hash, from its station_config.
    expect((await agent.bridge()!.displayCaller(tillId, bearer))?.kind).toBe('display');
  });

  // --- Round 4: selling offline ------------------------------------------------------

  const packageId = async (): Promise<string> => {
    const [pkg] = await ctx.db
      .select({ id: ticketPackage.id })
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
    return pkg!.id;
  };
  /** Price a cart on the box, as a till on the box lane does before taking the money. */
  const boxTotal = async (cart: Record<string, unknown>): Promise<number> => {
    const priced = await call('POST', bridge('intents'), cookie, intent('cart.quote', cart));
    expect(priced.statusCode, JSON.stringify(priced.body)).toBe(200);
    return (priced.body.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
  };
  const sell = async (type: string, payload: Record<string, unknown>) => {
    const res = await call('POST', bridge('intents'), cookie, intent(type, payload));
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    return res.body.result as {
      sale: { id: string; receiptNumber: string; totals: { grossSatang: number } };
      finalised: boolean;
      attempt: { status: string; approvalCode: string | null } | null;
      printing: { jobs: Array<{ kind: string; status: string }>; notes: string[] };
      drawer: string;
    };
  };
  /** The link back, everything queued pushed, and the ledger's row for a sale. */
  const landed = async (saleId: string) => {
    await goOnline();
    for (let i = 0; i < 10; i += 1) {
      if ((await agent.outbox()!.flush()).state !== 'pushed') break;
    }
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    await goOffline();
    return row;
  };
  const ticket = async (over: Record<string, unknown> = {}) => {
    const cart = { lines: [{ id: newId(), packageId: await packageId(), kids: 1, adults: 1 }], ...over };
    return { cart, total: await boxTotal(cart) };
  };

  it(`Cash — ${byOperation('Cash').offline.toLowerCase()}: the drawer opens after the sale is on disk, and it lands once`, async () => {
    const { cart, total } = await ticket();
    const saleId = newId();
    const paid = await sell('sale.finalise', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total },
    });
    expect(paid.finalised).toBe(true);
    expect(paid.drawer).not.toBe('not_asked');
    const row = await landed(saleId);
    expect(row).toMatchObject({ status: 'finalised', origin: 'box', receiptNumber: paid.sale.receiptNumber });
  });

  it(`Manual discount, ฿0 comp, tier change — ${byOperation('Manual discount, ฿0 comp, tier change').offline.toLowerCase()}: a comp closes with no tender and replays`, async () => {
    const { cart, total } = await ticket({
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' }],
    });
    expect(total).toBe(0);
    const saleId = newId();
    const comped = await sell('sale.finalise', {
      saleId,
      actionId: `comp-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: 0 },
      tender: null,
    });
    expect(comped.attempt).toBeNull();
    const row = await landed(saleId);
    expect(row).toMatchObject({ status: 'finalised', grossSatang: 0, receiptNumber: comped.sale.receiptNumber });
  });

  it(`Card on the terminal — ${byOperation('Card on the terminal').offline.toLowerCase()}: the counter's own terminal answers and the sale closes`, async () => {
    const { cart, total } = await ticket();
    const saleId = newId();
    const paid = await sell('payment.start', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: { actionId: `card-${saleId.slice(-8)}`, method: 'card', kind: 'card', amountSatang: total },
    });
    expect(paid.attempt?.status).toBe('approved');
    expect(paid.attempt?.approvalCode).toBeTruthy();
    const row = await landed(saleId);
    expect(row?.status).toBe('finalised');
    const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempt).toMatchObject({ status: 'approved', offline: true });
  });

  it(`PAX (Digio) QR — ${byOperation('PAX (Digio) QR').offline.toLowerCase()}: closed, and flagged awaiting settlement`, async () => {
    const { cart, total } = await ticket();
    const saleId = newId();
    const paid = await sell('payment.start', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: { actionId: `qr-${saleId.slice(-8)}`, method: 'promptpay', kind: 'qr', amountSatang: total },
    });
    expect(paid.finalised).toBe(true);
    expect(paid.attempt?.status).toBe('awaiting_settlement');
    await landed(saleId);
    const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempt?.status).toBe('awaiting_settlement');
  });

  it(`Receipt and bands for an offline sale — ${byOperation('Receipt and bands for an offline sale').offline.toLowerCase()}: from the box's snapshot and print queue`, async () => {
    const { cart, total } = await ticket();
    const saleId = newId();
    const paid = await sell('sale.finalise', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total },
    });
    expect(paid.printing.jobs.find((j) => j.kind === 'receipt')?.status).toBe('printed');
    expect(paid.printing.jobs.find((j) => j.kind === 'kids_wristband')?.status).toBe('printed');
    expect(paid.printing.jobs.find((j) => j.kind === 'adult_wristband')?.status).toBe('printed');
    const logged = await agent.sales()!.recorded(saleId);
    for (const minted of logged!.bands) {
      expect(verifyBandCode(minted.code, currentBandKey()!).ok).toBe(true);
    }
    await landed(saleId);
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bands.map((b) => b.code).sort()).toEqual(logged!.bands.map((b) => b.code).sort());
  });

  it(`Reprint — ${byOperation('Reprint').offline.toLowerCase()}: from the box's own print log`, async () => {
    const { cart, total } = await ticket();
    const saleId = newId();
    await sell('sale.finalise', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total },
    });
    const copy = await call(
      'POST',
      bridge('intents'),
      cookie,
      intent('sale.reprint', { saleId, kind: 'receipt', reason: 'Guest asked' }),
    );
    expect(copy.statusCode, JSON.stringify(copy.body)).toBe(200);
    expect((copy.body.result as { jobs: Array<{ kind: string; status: string }> }).jobs).toEqual([
      expect.objectContaining({ kind: 'receipt', status: 'printed' }),
    ]);
    const elsewhere = await call(
      'POST',
      bridge('intents'),
      cookie,
      intent('sale.reprint', { saleId: newId(), kind: 'receipt' }),
    );
    expect(elsewhere.statusCode).toBe(404);
    expect((elsewhere.body.error as { code: string }).code).toBe('REPRINT_NOT_ON_THIS_BOX');
  });

  it('and on the box lane the refusal rows are refused in the capability list’s own reasons', async () => {
    const refusedAs = async (type: string, payload: Record<string, unknown>, code: string) => {
      const res = await call('POST', bridge('intents'), cookie, intent(type, payload));
      expect(res.statusCode, `${type}: ${JSON.stringify(res.body)}`).toBe(409);
      expect((res.body.error as { code: string }).code).toBe(code);
    };
    await refusedAs('payment.2c2p', {}, BOX_LANE_REFUSALS.qr2c2p.code);
    await refusedAs('payment.voucher', {}, BOX_LANE_REFUSALS.voucher.code);
    await refusedAs('payment.wallet', {}, BOX_LANE_REFUSALS.wallet.code);
    // S2-12 round 5: a booking now rides the bridge, redeemed from the box's
    // own copy; one the box holds no copy of is refused in the counter's words.
    const unknownBooking = await call(
      'POST',
      bridge('intents'),
      cookie,
      intent('booking.redeem', { bookingId: newId(), actionId: 'redeem-unknown' }),
    );
    expect(unknownBooking.statusCode, JSON.stringify(unknownBooking.body)).toBe(404);
    expect((unknownBooking.body.error as { code: string }).code).toBe('BOOKING_NOT_ON_BOX');
    await refusedAs('sale.refund', {}, BOX_LANE_REFUSALS.refund.code);
    await refusedAs('sale.void', {}, BOX_LANE_REFUSALS.refund.code);
    // A voucher riding a cart is refused before anything is numbered.
    const { cart, total } = await ticket();
    await refusedAs(
      'sale.finalise',
      {
        saleId: newId(),
        actionId: 'pay-voucher',
        cart: { ...cart, promoCodes: [mintBoothCode('B1', (n) => 7 % n)], expectedTotalSatang: total },
        tender: { actionId: 'cash-voucher', method: 'cash', kind: 'cash', amountSatang: total },
      },
      BOX_LANE_REFUSALS.voucher.code,
    );
  });
});
