import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 as boxUuidv7 } from '@oto/box-agent';
import {
  account,
  box,
  branch,
  branchHoliday,
  child,
  device,
  deviceCredential,
  fileObject,
  member,
  operator,
  productCategory,
  roleAssignment,
  station,
  taxOverride,
  ticketPackage,
} from '@oto/db';
import {
  cartUnits,
  deriveId,
  deriveSaleLineId,
  newId,
  type PackagePricingShape,
  type PricingContext,
  type TicketCartLine,
} from '@oto/shared';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/env';
import { storedCartLineIds, type CartLineInput } from '../src/services/sale';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { readFunctions, readRoutes, reachesText, type SourceRoute } from './route-source';

/**
 * SCRUM-270 (and SCRUM-279) — THE IDS, IN ONE PLACE.
 *
 * `ARCHITECTURE.md` §9 has said since Sprint 1 that ids are minted by the
 * client. Plan `docs/progress/plans/offline/PLAN.md` OD-12 says by which one:
 * the till mints the sale, every line and item, the action per press, each
 * member, child and visit; the box mints receipt numbers, bands, print jobs and
 * its own events; the platform keeps the rows nothing outside it refers to and
 * the records an administrator creates — whose routes take an OPTIONAL id in
 * the body. Offline selling rests on every one of those holding, so this file
 * holds them:
 *
 *   1. the two UUIDv7 generators — `@oto/shared`'s `newId()` and the box's own
 *      `uuidv7()` — lay an id out the same way, and so does the one function
 *      that NAMES a sale line from the till's ids (`deriveSaleLineId`);
 *   2. the rule a replayed sale is judged by agrees with the engine's units;
 *   3. the surface: every create route OD-12 gives a caller-minted id reads
 *      one, and every other create route that still mints its record's id on
 *      the platform is named below with the reason — an exact list, so a new
 *      one fails here on the day it is written;
 *   4. driven against a real database, every one of those routes answers a
 *      second arrival of the same id as a replay, and refuses an id that names
 *      somebody else's record.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The 48-bit millisecond timestamp at the front of a UUIDv7. */
const msOf = (id: string): number => parseInt(id.replace(/-/g, '').slice(0, 12), 16);

// --- 1 · One layout ----------------------------------------------------------

describe('the two UUIDv7 generators lay an id out the same way (SCRUM-279)', () => {
  it('both mint version 7, the RFC 4122 variant, and the clock in the first 48 bits', () => {
    const before = Date.now();
    const ids = [newId(), boxUuidv7(), newId(), boxUuidv7()];
    const after = Date.now();
    for (const id of ids) {
      expect(id, id).toMatch(UUID_V7);
      expect(msOf(id)).toBeGreaterThanOrEqual(before);
      expect(msOf(id)).toBeLessThanOrEqual(after);
    }
  });

  it('sort in the order they were minted across milliseconds, whichever minted them', async () => {
    // What the outbox and every append-mostly index lean on: a box's id and
    // the platform's, minted a millisecond apart, sort as they happened.
    const minted: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      minted.push(i % 2 === 0 ? newId() : boxUuidv7());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect([...minted].sort()).toEqual(minted);
  });

  it("the box's generator puts the clock it is given exactly where the platform's would", () => {
    const at = Date.UTC(2026, 8, 30, 3, 0, 0, 123);
    const id = boxUuidv7(at);
    expect(id).toMatch(UUID_V7);
    expect(msOf(id)).toBe(at);
  });
});

describe('a sale line is NAMED from what the till minted (SCRUM-270)', () => {
  const saleId = '01923f6a-7b2c-7d4e-8f10-111213141516';
  const lineId = '01923f6a-7b2c-7d4e-9f10-aaaaaaaaaaaa';

  it('is a UUIDv7 carrying its sale’s own clock, so it sits beside the sale in every index', () => {
    const id = deriveSaleLineId(saleId, lineId, 'kids');
    expect(id).toMatch(UUID_V7);
    expect(msOf(id)).toBe(msOf(saleId));
  });

  it('is the same wherever it is computed — pinned, so no tidy-up renames an unsaved line', () => {
    expect(deriveId(saleId, 'sale_line:x:kids:0')).toBe('01923f6a-7b2c-7ffd-865b-2a0afffe63b6');
    expect(deriveSaleLineId(saleId, lineId, 'kids', 0)).toBe('01923f6a-7b2c-7277-bc17-fd5a04e7eb9c');
    // The case a uuid arrives in does not change the name.
    expect(deriveSaleLineId(saleId.toUpperCase(), lineId.toUpperCase(), 'kids', 0)).toBe(
      '01923f6a-7b2c-7277-bc17-fd5a04e7eb9c',
    );
  });

  it('differs for every sale, line, unit and occurrence', () => {
    const otherSale = newId();
    const names = new Set([
      deriveSaleLineId(saleId, lineId, 'kids', 0),
      deriveSaleLineId(saleId, lineId, 'kids', 1),
      deriveSaleLineId(saleId, lineId, 'adults', 0),
      deriveSaleLineId(saleId, newId(), 'kids', 0),
      deriveSaleLineId(otherSale, lineId, 'kids', 0),
    ]);
    expect(names.size).toBe(5);
    // And it does not collide across a day's worth of lines.
    const day = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) day.add(deriveSaleLineId(saleId, newId(), 'kids', 0));
    expect(day.size).toBe(20_000);
  });

  it('refuses to derive from something that is not an id', () => {
    expect(() => deriveId('promo-ICECREAM', 'x')).toThrow(/uuid/);
  });
});

// --- 2 · The replay rule agrees with the engine ------------------------------

describe('the ids a replayed sale is compared on are the engine’s units (SCRUM-270)', () => {
  it('a cart line leaves an id on the ledger exactly when the engine prices it into a unit', () => {
    const ctx: PricingContext = {
      mode: 'weekday',
      socks: { addOnId: 'a-socks', price: 4_000, label: 'Regular Socks' },
    };
    const packages: PackagePricingShape[] = [
      { prices: { tourist: { weekday: 89_000, weekend: 89_000 } }, adultRules: null },
      {
        prices: { tourist: { weekday: 62_000, weekend: 62_000 } },
        adultRules: { tourist: { kind: 'free_adults', freeAdults: 1, overflow: 'same_as_kid' } },
      },
    ];
    let checked = 0;
    for (const pkg of packages)
      for (const kids of [0, 1])
        for (const adults of [0, 1, 2])
          for (const socks of [0, 1])
            for (const addOns of [0, 1])
              for (const fee of [null, 0, 15_000])
                for (const food of [null, 0, 5_000])
                  for (const promo of [false, true]) {
                    const id = newId();
                    const engineLine: TicketCartLine = {
                      id,
                      packageId: newId(),
                      package: pkg,
                      tier: 'tourist',
                      kids,
                      adults,
                      socks,
                      addOns: addOns ? [{ id: 'a-locker', name: 'Locker', price: 2_000, quantity: 1 }] : [],
                      serviceFee: fee === null ? null : { label: 'Drop-off service', amount: fee },
                      lineTotal: 0,
                      ...(promo
                        ? { promoItem: { itemId: 'm-icecream', itemKind: 'menu' as const, name: 'Ice cream', price: 6_000 } }
                        : {}),
                      ...(food === null ? {} : { foodProvision: { mode: 'prepaid_items' as const, paid: food } }),
                    };
                    const sent: CartLineInput = {
                      id,
                      packageId: engineLine.packageId,
                      kids,
                      adults,
                      socks,
                      addOns: addOns ? [{ id: 'a-locker', quantity: 1 }] : [],
                      serviceFee: fee === null ? null : { label: 'Drop-off service', amountSatang: fee },
                      foodProvision: food === null ? null : { mode: 'prepaid_items', paidSatang: food },
                      promoItem: promo
                        ? { itemId: 'm-icecream', itemKind: 'menu', name: 'Ice cream', priceSatang: 6_000 }
                        : null,
                    };
                    const engine = cartUnits([engineLine], ctx).length > 0;
                    expect(storedCartLineIds({ lines: [sent] }).has(id), JSON.stringify(sent)).toBe(engine);
                    checked += 1;
                  }
    expect(checked).toBe(2 * 2 * 3 * 2 * 2 * 3 * 3 * 2);
    // Every F&B and shop row is one unit, always.
    const itemId = newId();
    expect(storedCartLineIds({ items: [{ id: itemId, productId: newId(), quantity: 1 }] }).has(itemId)).toBe(
      true,
    );
  });
});

// --- 3 · The surface, read from the source ------------------------------------

/**
 * Every create route whose record OD-12 lets the CALLER name.
 *
 * The till's (members, children, visits, sales) and the administrator's
 * (accounts, grants, branches, the catalogue rows, files, operators, the
 * fleet), plus the public booking, which has taken one since SCRUM-298.
 */
const CALLER_NAMED = [
  'POST /accounts',
  'POST /accounts/:id/role-assignments',
  'POST /boxes/:boxId/devices',
  'POST /branches',
  'POST /branches/:branchId/boxes',
  'POST /branches/:branchId/holidays',
  'POST /branches/:branchId/stations',
  'POST /branches/:branchId/tax-overrides',
  'POST /branches/:branchId/ticket-packages',
  'POST /files',
  'POST /members',
  'POST /members/:id/children',
  'POST /operators',
  'POST /operators/:id/administrators',
  'POST /public/bookings',
  'POST /sales',
  'POST /stations/:id/credentials',
  'POST /visits',
];

/**
 * The create routes that still mint their record's id on the platform, each
 * with why. Exact in both directions: a route that starts taking a body id
 * fails here until it is moved to the list above, and a new create route that
 * mints its own fails until somebody decides which list it belongs on.
 */
const NEXT_PASS =
  "an administrator's create outside round 1's named list (plan §4): it takes an optional body id the same way, in the pass that follows";
const ACTION_KEYED = 'keyed by the press the caller minted (`x-oto-action-id`), which is what makes a retry the same act';
const CODE_NAMED = 'named by the code the Console mints from the label, which is what every reader refers to it by';

const PLATFORM_NAMED: Record<string, string> = {
  'POST /admin/apps/:app/users': NEXT_PASS,
  // A session is the platform's own: the cookie carries a token, never the id.
  'POST /auth/sign-in': 'the session a sign-in opens; nothing outside the platform refers to its id',
  'POST /bookings/:id/redeem': 'derived: the sale and its bands come from the paid booking, which names the work; one redemption row per booking is the uniqueness',
  'POST /booth-layouts': NEXT_PASS,
  'POST /booths/:id/pairing-codes': 'a one-time code, answered once (`secretResponse`); a second press revokes the first',
  'POST /booths/:id/prizes': NEXT_PASS,
  'POST /booths/:id/duty': NEXT_PASS,
  'POST /booths/:id/duty/sync': 'derived: the dated roster is keyed by booth and day, never by a client id',
  'POST /booths/:id/publish': 'derived: a published version of the booth’s own setup',
  'POST /boxes/:id/commands': ACTION_KEYED,
  'POST /boxes/:id/simulate': ACTION_KEYED,
  'POST /branches/:branchId/menu/products': NEXT_PASS,
  'POST /members/:id/tier-verification':
    'the evidence row behind a tier change; round 3 makes it the till’s `member.tier_changed` fact (plan §2.3, OD-11)',
  'POST /menu/categories': NEXT_PASS,
  'POST /menu/discounts': NEXT_PASS,
  'POST /menu/modifier-groups': NEXT_PASS,
  'POST /payment-methods': CODE_NAMED,
  'POST /payments/attempts/:id/inquire': 'derived: an inquiry of an attempt the caller already named',
  'POST /print-jobs/:id/reprint': 'a print job: the box names its own offline (OD-12); online the platform queues it',
  'POST /sales/:id/refunds': `${ACTION_KEYED} (\`refund_action_unique\`); refunds are online only (decision 8)`,
  'POST /sales/tier-claims': `${ACTION_KEYED} (\`sale_tier_claim_action_unique\`)`,
  'POST /stations/:id/displays/claim': 'derived: the credential a paired display is answered with, once',
  'POST /tiers': CODE_NAMED,
  'POST /voucher-definitions': NEXT_PASS,
  'PUT /booths/:id/staff/:accountId/pin': 'derived: one PIN row per account and booth, named by the path',
  'PUT /checkin/config/confirmations':
    "derived: the list is replaced whole and each item is named by the client's code, unique per branch while live; the row id is never referred to",
};

/** A create that picks its record's id here: `const id = newId()`, `const refundId = newId()`. */
const MINTS_ITS_ID = (body: string): boolean =>
  /\b(?:const|let)\s+\w*[iI]d\s*=\s*newId\(\)/.test(body);

/** A create that reads the caller's id: the shared claim, or the sale's and booking's own. */
const READS_A_BODY_ID = (body: string): boolean =>
  /\bclaimClientId\s*\(|\binput\.id\s*\?\?|\breq\.body\.id\s*\?\?/.test(body);

describe('every create names its record where OD-12 says (SCRUM-270)', () => {
  let app: App;
  let routes: SourceRoute[];
  let functions: ReturnType<typeof readFunctions>;
  let credentialed: Set<string>;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
    app = await buildApp({ env, db: {} as never, fileStorage: null });
    routes = readRoutes();
    functions = readFunctions();
    // A machine's own surface (the box, a paired screen) is the box's to
    // name, through its outbox and its sync ledger: out of scope here.
    credentialed = new Set(
      app.routeRegistry.filter((r) => r.config.credential).map((r) => `${r.method} ${r.url}`),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('every route on either list is a route the app serves', () => {
    const live = new Set(app.routeRegistry.map((r) => `${r.method} ${r.url}`));
    expect([...CALLER_NAMED, ...Object.keys(PLATFORM_NAMED)].filter((k) => !live.has(k)).sort()).toEqual([]);
  });

  it('every caller-named create reads the id it was sent', () => {
    const blind = CALLER_NAMED.filter((key) => {
      const route = routes.find((r) => `${r.method} ${r.path}` === key);
      return !route || !reachesText(route.handlerText, READS_A_BODY_ID, functions, 2);
    });
    expect(blind, 'declared caller-named, but the handler never reads a body id').toEqual([]);
  });

  it('every other create that mints its own id is named, with why', () => {
    const minting = routes
      .filter((r) => r.method === 'POST' || r.method === 'PUT')
      .map((r) => ({ key: `${r.method} ${r.path}`, route: r }))
      .filter(({ key }) => !credentialed.has(key) && !CALLER_NAMED.includes(key))
      .filter(({ route }) => reachesText(route.handlerText, MINTS_ITS_ID, functions, 1))
      .map(({ key }) => key)
      .sort();
    expect(minting, 'a create that mints its record id on the platform — take a body id, or say why here').toEqual(
      Object.keys(PLATFORM_NAMED).sort(),
    );
  });
});

// --- 4 · Driven: the same id twice is one record -----------------------------

describe('a create sent twice under one id is one record (SCRUM-270)', () => {
  let ctx: TestContext;
  let cookie: string;
  let operatorId: string;
  let branchId: string;
  let otherBranchId: string;
  let memberId: string;
  let otherMemberId: string;
  let boxId: string;
  let tillId: string;
  let accountId: string;

  const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload });

  /**
   * Send a create twice under one body id — each with its own Idempotency-Key,
   * so the second reaches the route rather than the header cache — and return
   * both answers after checking the shape every replay has.
   */
  async function twice(url: string, payload: Record<string, unknown>, idOf: (body: Record<string, unknown>) => unknown) {
    const id = newId();
    const first = await post(url, { ...payload, id }, { 'idempotency-key': newId() });
    expect(first.statusCode, first.body).toBe(200);
    expect(idOf(first.json())).toBe(id);
    expect(first.headers['x-oto-replay']).toBeUndefined();
    const second = await post(url, { ...payload, id }, { 'idempotency-key': newId() });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(idOf(second.json())).toBe(id);
    return { id, first, second };
  }

  /** An id that already names a record of another kind of parent is refused, and nothing is written. */
  async function refusesTaken(url: string, payload: Record<string, unknown>, takenId: string) {
    const res = await post(url, { ...payload, id: takenId }, { 'idempotency-key': newId() });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toEqual({
      code: 'ID_IN_USE',
      message:
        'That id already names another record, so nothing was saved — send the create again with a new id',
      details: { id: takenId },
    });
  }

  beforeAll(async () => {
    ctx = await createTestContext({ files: true });
    cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const branches = await ctx.db.select().from(branch);
    const hkt = branches.find((b) => b.code === 'hkt-central')!;
    branchId = hkt.id;
    operatorId = hkt.operatorId;
    otherBranchId = branches.find((b) => b.operatorId === operatorId && b.id !== branchId)!.id;
    const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
    memberId = members[0]!.id;
    otherMemberId = members[1]!.id;
    const [till] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')))
      .limit(1);
    tillId = till!.id;
    boxId = till!.boxId!;
    const [someone] = await ctx.db.select().from(account).where(eq(account.operatorId, operatorId)).limit(1);
    accountId = someone!.id;
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
    await teardownAll();
  });

  it('refuses a body id that is not a uuid, before anything is read', async () => {
    const res = await post(`/members/${memberId}/children`, { id: 'child-1', name: 'Mai' });
    expect(res.statusCode).toBe(400);
  });

  it("the till's: a child, a member and a visit", async () => {
    const kid = await twice(`/members/${memberId}/children`, { name: 'Replay child' }, (b) => (b.child as { id: string }).id);
    expect(await ctx.db.select().from(child).where(eq(child.id, kid.id))).toHaveLength(1);
    // The same child's id offered to another member names somebody else's child.
    await refusesTaken(`/members/${otherMemberId}/children`, { name: 'Replay child' }, kid.id);

    const phone = `+6689${String(Date.now()).slice(-7)}`;
    const made = await twice('/members', { phone, nickname: 'Replay' }, (b) => (b.member as { id: string }).id);
    expect(await ctx.db.select().from(member).where(eq(member.id, made.id))).toHaveLength(1);

    const visited = await twice('/visits', { memberId, childIds: [kid.id], branchId }, (b) => b.id);
    expect(visited.second.json().status).toBe('draft');
  });

  it('accounts and their grants', async () => {
    const phone = `+6687${String(Date.now()).slice(-7)}`;
    const made = await twice('/accounts', { phone, employeeName: 'Replay Staff' }, (b) => b.id);
    expect(made.second.json()).toEqual({ id: made.id, status: 'invited' });
    expect(await ctx.db.select().from(account).where(eq(account.id, made.id))).toHaveLength(1);

    const grant = { roleName: 'reception', scopeType: 'branch', scopeId: branchId };
    const granted = await twice(`/accounts/${made.id}/role-assignments`, grant, (b) => b.id);
    expect(await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, granted.id))).toHaveLength(1);
    // That grant's id offered for another account is somebody else's record.
    await refusesTaken(`/accounts/${accountId}/role-assignments`, grant, granted.id);
  });

  it('branches, operators and their administrators', async () => {
    const code = `replay-${String(Date.now()).slice(-6)}`;
    const opened = await twice('/branches', { name: 'Replay Park', code }, (b) => b.id);
    expect(await ctx.db.select().from(branch).where(eq(branch.id, opened.id))).toHaveLength(1);

    const op = await twice('/operators', { name: 'Replay Operator' }, (b) => b.id);
    expect(await ctx.db.select().from(operator).where(eq(operator.id, op.id))).toHaveLength(1);

    const phone = `+6686${String(Date.now()).slice(-7)}`;
    const admin = await twice(`/operators/${op.id}/administrators`, { phone, name: 'Replay Admin' }, (b) => b.accountId);
    expect(admin.second.json()).toEqual({ accountId: admin.id });
    // An account of the first operator is not the second one's administrator.
    await refusesTaken(`/operators/${op.id}/administrators`, { phone: `+6685${String(Date.now()).slice(-7)}`, name: 'X' }, accountId);
  });

  it('the catalogue: a package, a holiday range and a tax override', async () => {
    const [pkg] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId)).limit(1);
    const body = {
      name: 'Replay Package',
      durationLabel: '1 Hour',
      hours: 1,
      prices: { tourist: { weekday: 50_000, weekend: 50_000 } },
    };
    const made = await twice(`/branches/${branchId}/ticket-packages`, body, (b) => b.id);
    expect(await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, made.id))).toHaveLength(1);
    // Another branch's package is not this branch's to replay.
    await refusesTaken(`/branches/${otherBranchId}/ticket-packages`, body, pkg!.id);

    const range = await twice(
      `/branches/${branchId}/holidays`,
      { name: 'Replay Day', startsOn: '2031-01-02', endsOn: '2031-01-02' },
      (b) => b.id,
    );
    expect(await ctx.db.select().from(branchHoliday).where(eq(branchHoliday.id, range.id))).toHaveLength(1);

    const [category] = await ctx.db
      .select()
      .from(productCategory)
      .where(eq(productCategory.operatorId, operatorId))
      .limit(1);
    const override = await twice(
      `/branches/${branchId}/tax-overrides`,
      { productId: null, categoryId: category!.id, vatRateBp: 700 },
      (b) => b.id,
    );
    expect(await ctx.db.select().from(taxOverride).where(eq(taxOverride.id, override.id))).toHaveLength(1);
  });

  it('a file, with a fresh upload URL on the replay', async () => {
    const made = await twice(
      '/files',
      { contentType: 'image/png', ownerEntityType: 'member', ownerEntityId: memberId, filename: 'face.png' },
      (b) => b.id,
    );
    expect(typeof made.second.json().uploadUrl).toBe('string');
    expect(await ctx.db.select().from(fileObject).where(eq(fileObject.id, made.id))).toHaveLength(1);
    // The same file offered as another member's photo is somebody else's file.
    await refusesTaken(
      '/files',
      { contentType: 'image/png', ownerEntityType: 'member', ownerEntityId: otherMemberId, filename: 'face.png' },
      made.id,
    );
  });

  it('the fleet: a station and a device replay; a box and a pairing code are shown once', async () => {
    const station1 = await twice(
      `/branches/${branchId}/stations`,
      { name: 'Replay Till', kind: 'till', boxId, capabilities: ['tickets'], accessScope: 'all_staff', staffAccountIds: [], devices: [] },
      (b) => (b.station as { id: string }).id,
    );
    expect(await ctx.db.select().from(station).where(eq(station.id, station1.id))).toHaveLength(1);

    const printer = await twice(
      `/boxes/${boxId}/devices`,
      { kind: 'receipt_printer', label: 'Replay printer', transport: 'lan', address: '192.168.88.251:9100' },
      (b) => (b.device as { id: string }).id,
    );
    expect(await ctx.db.select().from(device).where(eq(device.id, printer.id))).toHaveLength(1);

    // A box: the first answer carries its one-time claim code; the same id
    // again is refused by name rather than handed a second code.
    const boxIdSent = newId();
    const slot = `replay-${String(Date.now()).slice(-6)}`;
    const registered = await post(`/branches/${branchId}/boxes`, { id: boxIdSent, name: 'Replay box', slot, role: 'counter' });
    expect(registered.statusCode, registered.body).toBe(200);
    expect(registered.json().box.id).toBe(boxIdSent);
    const again = await post(`/branches/${branchId}/boxes`, { id: boxIdSent, name: 'Replay box', slot, role: 'counter' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('BOX_ALREADY_REGISTERED');
    expect(again.json().error.details).toEqual({ boxId: boxIdSent });
    expect(await ctx.db.select().from(box).where(eq(box.id, boxIdSent))).toHaveLength(1);

    // A pairing code, the same way.
    const credentialId = newId();
    const paired = await post(`/stations/${tillId}/credentials`, { id: credentialId, kind: 'kiosk', label: 'Replay kiosk' });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json().credential.id).toBe(credentialId);
    const repaired = await post(`/stations/${tillId}/credentials`, { id: credentialId, kind: 'kiosk', label: 'Replay kiosk' });
    expect(repaired.statusCode).toBe(409);
    expect(repaired.json().error.code).toBe('CREDENTIAL_ALREADY_ISSUED');
    expect(await ctx.db.select().from(deviceCredential).where(eq(deviceCredential.id, credentialId))).toHaveLength(1);

    // The station's id offered at another branch is somebody else's station.
    await refusesTaken(
      `/branches/${otherBranchId}/stations`,
      { name: 'Replay Till', kind: 'till', boxId, capabilities: ['tickets'], accessScope: 'all_staff', staffAccountIds: [], devices: [] },
      station1.id,
    );
  });
});
