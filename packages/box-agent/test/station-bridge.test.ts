import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { OFFLINE_POLICY, OfflineMemberTierChangedSchema } from '@oto/shared';
import { BridgeError, StationBridge, type BridgeHost } from '../src/station-bridge';
import { StationSessionManager } from '../src/station-session';
import { encodeStaffToken, type StaffSigningKey, type StaffTokenClaims } from '../src/staff-token';
import type { CachedBundle } from '../src/store';
import {
  BOX_ID,
  BRANCH_ID,
  OPERATOR_ID,
  STATION_ID,
  openTestStore,
  type TestStore,
} from './_support';

/**
 * The station bridge on its own store (offline plan Round 3, SCRUM-269).
 *
 * SQLite, as a Pi runs it, with no cloud at all: every answer here is read
 * from what the box holds — its cache, its overlay, its outbox — which is the
 * whole claim the bridge makes. The api suite drives the same file over the
 * `edge` schema of Postgres, joined to a platform (`bridge-convergence.test.ts`).
 */

const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const STRANGER = '018f0000-0000-7000-8000-0000000000a9';
const KID = 'kid0123456789abc';
const T0 = '2026-09-30T03:00:00.000Z';

const pair = generateKeyPairSync('ed25519');
const PRIVATE = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEYS: StaffSigningKey[] = [
  { purpose: 'staff_token', kid: KID, algorithm: 'ed25519', publicKey: PUBLIC },
];

function token(now: Date, over: Partial<StaffTokenClaims> = {}): string {
  const iat = Math.floor(now.getTime() / 1000);
  return encodeStaffToken(
    {
      v: 1,
      jti: '018f0000-0000-7000-8000-0000000000f1',
      sub: ACCOUNT,
      aud: BRANCH_ID,
      sid: '018f0000-0000-7000-8000-0000000000e1',
      sta: STATION_ID,
      box: BOX_ID,
      iat,
      exp: iat + 16 * 3600,
      ...over,
    },
    { kid: KID, privateKeyPem: PRIVATE },
  );
}

const PERMISSIONS = [
  'pos:member:read',
  'pos:member:create',
  'pos:member:update',
  'pos:child:create',
  'pos:child:update',
  'pos:visit:create',
  'pos:sale:create',
];

const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const LATTE = '018f0000-0000-7000-8000-0000000000c1';
const MILK = '018f0000-0000-7000-8000-0000000000c2';
const OAT = '018f0000-0000-7000-8000-0000000000c3';
const DRINKS = '018f0000-0000-7000-8000-0000000000c4';

/** The catalogue scope as the api builds it (`cacheBundle` in `services/sync.ts`). */
function catalogue(version = 'v1') {
  return {
    version,
    packages: [
      {
        id: PACKAGE,
        name: '2 Hours Play',
        active: true,
        archivedAt: null,
        prices: {
          tourist: { weekday: 35000, weekend: 45000 },
          thai: { weekday: 25000, weekend: 30000 },
        },
        adultRules: null,
      },
    ],
    categories: [{ id: DRINKS, parentId: null, taxableCategory: 'fnb', name: 'Drinks' }],
    products: [
      {
        id: LATTE,
        kind: 'menu',
        name: 'Latte',
        priceSatang: 9000,
        priceWeekendSatang: null,
        categoryId: DRINKS,
        taxCategoryOverride: null,
        variants: [],
        active: true,
        archivedAt: null,
      },
    ],
    modifierGroups: [
      {
        id: MILK,
        productId: LATTE,
        name: 'Milk',
        required: true,
        selectionType: 'single',
        minSelect: null,
        maxSelect: null,
        sortOrder: 0,
      },
    ],
    modifierOptions: [
      {
        id: OAT,
        modifierGroupId: MILK,
        name: 'Oat',
        priceSatang: 1500,
        priceWeekendSatang: null,
        sortOrder: 0,
      },
    ],
    modifierLinks: [],
    tiers: [
      { code: 'tourist', isDefault: true, archivedAt: null },
      { code: 'thai', isDefault: false, archivedAt: null },
    ],
    holidays: [],
    taxConfig: {
      config: {
        rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
        categoryRules: [
          { category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' },
          { category: 'fnb', taxRateId: 'vat', taxMode: 'inclusive' },
        ],
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
  };
}

interface Rig {
  t: TestStore;
  bridge: StationBridge;
  sessions: StationSessionManager;
  now: { at: Date };
  write(scope: CachedBundle['scope'], items: unknown[], appliedAt?: string): Promise<void>;
}

async function rig(opts: { seal?: boolean } = {}): Promise<Rig> {
  const t = openTestStore(T0);
  await t.store.init(BOX_ID);
  const now = { at: new Date(T0) };
  t.setNow(T0);
  const identity = {
    stationId: STATION_ID,
    boxId: BOX_ID,
    operatorId: OPERATOR_ID,
    branchId: BRANCH_ID,
  };
  const sessions = new StationSessionManager({
    store: t.store,
    boxId: BOX_ID,
    resolveStation: (id) => (id === STATION_ID ? identity : null),
    now: () => now.at,
  });
  const host: BridgeHost = {
    boxId: BOX_ID,
    store: t.store,
    sessions,
    station: (id) =>
      id === STATION_ID
        ? {
            id,
            name: 'Reception Till 1',
            kind: 'till',
            branchId: BRANCH_ID,
            operatorId: OPERATOR_ID,
          }
        : null,
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    signingKeys: () => KEYS,
    link: () => ({ up: false, offline: false }),
    sealer: () => (opts.seal === false ? null : t.seal),
    verifyPassword: async (hash, password) => hash === `argon:${password}`,
    now: () => now.at,
  };
  const write = async (
    scope: CachedBundle['scope'],
    items: unknown[],
    appliedAt = now.at.toISOString(),
  ) => {
    await t.store.writeBundle(BOX_ID, {
      scope,
      schemaVersion: 1,
      cursorSeq: 0,
      payload: { items },
      appliedAt,
    });
  };
  await write('staff', [
    {
      accountId: ACCOUNT,
      passwordHash: 'argon:open-sesame',
      status: 'active',
      mustChangePassword: false,
      lastTokenAt: new Date(Date.parse(T0) - 2 * 86_400_000).toISOString(),
      permissions: PERMISSIONS,
    },
    {
      accountId: STRANGER,
      passwordHash: 'argon:stranger',
      status: 'active',
      mustChangePassword: false,
      lastTokenAt: null,
      permissions: PERMISSIONS,
    },
  ]);
  await write('deny_list', [{ revokedAccountIds: [], revokedTokenIds: [] }]);
  await write('catalogue', [catalogue()]);
  await write('members', [
    {
      id: '018f0000-0000-7000-8000-00000000d001',
      phone: '+66811111111',
      nickname: 'Cached family',
      name: null,
      tierCode: 'thai',
      preferredChannel: 'line',
      childrenReviewSince: null,
      aliasIds: ['018f0000-0000-7000-8000-00000000d0aa'],
      children: [
        {
          id: '018f0000-0000-7000-8000-00000000c0c1',
          memberId: '018f0000-0000-7000-8000-00000000d001',
          name: 'Ploy',
          dateOfBirth: null,
          ageYears: 6,
          allergies: 'Peanuts',
          medicalNotes: null,
          medicalAlert: true,
          dietary: null,
          foodRestrictions: null,
        },
      ],
    },
  ]);
  await write('station_config', [
    {
      id: STATION_ID,
      displays: [
        {
          id: '018f0000-0000-7000-8000-0000000000d9',
          credentialHash: 'a3c5a8d1c35d7cb5b8e5e1a6e3f5d1a8b9a0b3d9e3e0e8f5e5c1a2b3c4d5e6f7',
        },
      ],
      offlinePolicy: OFFLINE_POLICY,
    },
  ]);
  return { t, bridge: new StationBridge(host), sessions, now, write };
}

const intent = (type: string, payload: Record<string, unknown>) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId: `act-${type}-${Math.random().toString(36).slice(2, 10)}`,
});

test('unlock with a live token and the password opens a box session bound to the station', async () => {
  const r = await rig();
  const answer = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  assert.equal(answer.response.method, 'offline_token');
  assert.equal(answer.response.offlineFresh, false);
  assert.match(answer.session, /^bs_/);
  const caller = await r.bridge.authenticate(STATION_ID, answer.session);
  assert.equal(caller?.accountId, ACCOUNT);
  assert.equal(
    await r.bridge.authenticate('018f0000-0000-7000-8000-000000000000', answer.session),
    null,
  );
  // Lock ends it.
  assert.equal(r.bridge.end(answer.session), true);
  assert.equal(await r.bridge.authenticate(STATION_ID, answer.session), null);
  r.t.close();
});

test('with no deny-list held, nobody is let in — not even with a perfect token', async () => {
  const r = await rig();
  await r.t.store.writeBundle(BOX_ID, {
    scope: 'deny_list',
    schemaVersion: 1,
    cursorSeq: 0,
    payload: { items: [] },
    appliedAt: T0,
  });
  await assert.rejects(
    r.bridge.unlock(STATION_ID, { token: token(r.now.at), password: 'open-sesame' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'OFFLINE_REVOCATION_UNKNOWN',
  );
  r.t.close();
});

test('a revoked token is refused, and a revocation pulled after unlock ends the session', async () => {
  const r = await rig();
  const opened = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  await r.write('deny_list', [
    { revokedAccountIds: [], revokedTokenIds: ['018f0000-0000-7000-8000-0000000000f1'] },
  ]);
  assert.equal(
    await r.bridge.authenticate(STATION_ID, opened.session),
    null,
    'the session ends at the next call',
  );
  await assert.rejects(
    r.bridge.unlock(STATION_ID, { token: token(r.now.at), password: 'open-sesame' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'STAFF_TOKEN_REVOKED',
  );
  r.t.close();
});

test('OD-6: a fresh sign-in is admitted for somebody seen here in 30 days while the deny-list is under 72 hours old', async () => {
  const r = await rig();
  const answer = await r.bridge.unlock(STATION_ID, { password: 'open-sesame', accountId: ACCOUNT });
  assert.equal(answer.response.method, 'offline_sign_in');
  assert.equal(answer.response.offlineFresh, true);

  // Never seen on this box: not recognised.
  await assert.rejects(
    r.bridge.unlock(STATION_ID, { password: 'stranger', accountId: STRANGER }),
    (err: unknown) => err instanceof BridgeError && err.code === 'OFFLINE_NOT_RECOGNISED',
  );

  // The deny-list three days and a minute old: refused, in its own words.
  r.now.at = new Date(Date.parse(T0) + 72 * 3_600_000 + 60_000);
  await assert.rejects(
    r.bridge.unlock(STATION_ID, { password: 'open-sesame', accountId: ACCOUNT }),
    (err: unknown) => err instanceof BridgeError && err.code === 'OFFLINE_DENY_LIST_STALE',
  );
  // A live token is still fine: its own sixteen hours are its bound (OD-5).
  await r.bridge.unlock(STATION_ID, { token: token(r.now.at), password: 'open-sesame' });
  r.t.close();
});

test('five wrong passwords lock the account out on the store, so a restart does not reset it', async () => {
  const r = await rig();
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(
      r.bridge.unlock(STATION_ID, { token: token(r.now.at), password: 'wrong' }),
      (err: unknown) => err instanceof BridgeError && err.code === 'OFFLINE_WRONG_PASSWORD',
    );
  }
  await assert.rejects(
    r.bridge.unlock(STATION_ID, { token: token(r.now.at), password: 'wrong' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'OFFLINE_LOCKED_OUT',
  );
  const held = await r.t.store.readThrottle(BOX_ID, 'bridge_unlock', ACCOUNT);
  assert.ok(held?.lockedUntil, 'the lockout is on disk');
  r.t.close();
});

test('a member signed up offline is a fact and an overlay row, written together, and the next lookup finds it', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    password: 'open-sesame',
    accountId: ACCOUNT,
  });
  const memberId = '018f0000-0000-7000-8000-00000000d002';
  const created = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.create', { memberId, phone: '081 222 3333', nickname: 'New family' }),
  );
  assert.equal((created.result?.member as { id: string }).id, memberId);

  const found = await r.bridge.lookup(STATION_ID, caller, '0812223333');
  assert.equal(found?.id, memberId);
  assert.equal(found?.source, 'overlay');
  assert.equal(found?.tierCode, 'tourist', "the operator's default tier from the cached catalogue");

  const childId = '018f0000-0000-7000-8000-00000000c0c2';
  await r.bridge.intent(
    STATION_ID,
    caller,
    intent('child.create', { childId, memberId, name: 'Mew', ageYears: 4, allergies: 'Milk' }),
  );
  const visit = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('visit.create', {
      visitId: '018f0000-0000-7000-8000-00000000e0e1',
      memberId,
      childIds: [childId],
    }),
  );
  assert.equal(visit.result?.status, 'draft');
  assert.equal(
    (await r.bridge.lookup(STATION_ID, caller, '+66812223333'))?.children[0]?.allergies,
    'Milk',
  );

  // Three facts on the outbox, each stamped as made under a fresh sign-in.
  const batch = await r.t.store.takeBatch(BOX_ID);
  assert.deepEqual(
    batch.events.map((e) => e.type),
    ['member.created', 'child.created', 'visit.created'],
  );
  assert.ok(batch.events.every((e) => e.payload.offlineFresh === true));
  assert.equal(batch.events[0]!.actorAccountId, ACCOUNT);
  assert.equal(batch.events[0]!.stationId, STATION_ID);

  // The same phone again is the same family, refused by name.
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('member.create', {
        memberId: '018f0000-0000-7000-8000-00000000d003',
        phone: '+66812223333',
        nickname: 'Twice',
      }),
    ),
    (err: unknown) => err instanceof BridgeError && err.code === 'MEMBER_PHONE_EXISTS',
  );
  r.t.close();
});

test('the alias rule, box side: a child recorded under a merged id is filed under the survivor', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const merged = '018f0000-0000-7000-8000-00000000d0aa';
  await r.bridge.intent(
    STATION_ID,
    caller,
    intent('child.create', {
      childId: '018f0000-0000-7000-8000-00000000c0c3',
      memberId: merged,
      name: 'Nam',
    }),
  );
  const [event] = (await r.t.store.takeBatch(BOX_ID)).events;
  assert.equal(event!.payload.memberId, '018f0000-0000-7000-8000-00000000d001');
  assert.equal(event!.payload.offlineFresh, undefined, 'a live token is not a fresh sign-in');
  const family = await r.bridge.lookup(STATION_ID, caller, '0811111111');
  assert.deepEqual(family?.children.map((c) => c.name).sort(), ['Nam', 'Ploy']);
  r.t.close();
});

test('a cart is priced from the cached catalogue; after seven days the box refuses to sell', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const lineId = '018f0000-0000-7000-8000-0000000001a1';
  const itemId = '018f0000-0000-7000-8000-0000000001a2';
  const cart = {
    memberId: '018f0000-0000-7000-8000-00000000d001',
    lines: [{ id: lineId, packageId: PACKAGE, kids: 2, adults: 0 }],
    items: [
      {
        id: itemId,
        productId: LATTE,
        quantity: 1,
        modifiers: [{ groupId: MILK, optionIds: [OAT] }],
      },
    ],
  };
  const answer = await r.bridge.intent(STATION_ID, caller, intent('cart.quote', cart));
  const quote = answer.result?.quote as {
    tier: string;
    lineTotals: Record<string, number>;
    totals: { grossSatang: number };
    catalogueVersion: string;
  };
  assert.equal(quote.tier, 'thai', "the member's cached tier, never the cart's");
  assert.equal(quote.lineTotals[lineId], 2 * 25000);
  assert.equal(quote.lineTotals[itemId], 9000 + 1500);
  assert.equal(quote.totals.grossSatang, 50000 + 10500);
  assert.equal(quote.catalogueVersion, 'v1');

  // A required question left unanswered is refused as the platform refuses it.
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('cart.quote', { items: [{ id: itemId, productId: LATTE, quantity: 1 }] }),
    ),
    (err: unknown) => err instanceof BridgeError && err.status === 400,
  );

  r.now.at = new Date(Date.parse(T0) + 7 * 86_400_000 + 1_000);
  await assert.rejects(
    r.bridge.intent(STATION_ID, caller, intent('cart.quote', cart)),
    (err: unknown) => err instanceof BridgeError && err.code === 'BOX_CATALOGUE_TOO_OLD',
  );
  const status = await r.bridge.status(STATION_ID);
  assert.equal(status.catalogue.state, 'refused');
  assert.equal(status.link.lane, 'box');
  r.t.close();
});

test('offline tier: a member is priced at their own tier or, when staff pick it, the default tier', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const lineId = '018f0000-0000-7000-8000-0000000001c1';
  const member = '018f0000-0000-7000-8000-00000000d001'; // cached at the Thai rate

  // The till rang the Thai member up at the staff-picked Tourist rate: the box
  // honours it and the till's own line total agrees, so the pay press is not
  // refused as SALE_LINE_PRICE_MISMATCH — the sale the platform allows online.
  const atTourist = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('cart.quote', {
      memberId: member,
      tier: 'tourist',
      lines: [{ id: lineId, packageId: PACKAGE, kids: 2, adults: 0, lineTotalSatang: 2 * 35000 }],
    }),
  );
  const touristQuote = atTourist.result?.quote as {
    tier: string;
    tierSource: string;
    lineTotals: Record<string, number>;
  };
  assert.equal(touristQuote.tier, 'tourist', 'the tier the till sent prices the member');
  assert.equal(touristQuote.tierSource, 'default', 'the default rate needs no member proof');
  assert.equal(touristQuote.lineTotals[lineId], 2 * 35000);

  // The other way: the same member at their own Thai rate is still priced Thai.
  const atThai = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('cart.quote', {
      memberId: member,
      tier: 'thai',
      lines: [{ id: lineId, packageId: PACKAGE, kids: 2, adults: 0, lineTotalSatang: 2 * 25000 }],
    }),
  );
  const thaiQuote = atThai.result?.quote as { tier: string; lineTotals: Record<string, number> };
  assert.equal(thaiQuote.tier, 'thai');
  assert.equal(thaiQuote.lineTotals[lineId], 2 * 25000);

  // The box prices the allowed default tier, so a Tourist cart carrying a Thai line total is
  // a real disagreement and is still refused — proof it is not quietly pricing
  // the member's own tier under the covers.
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('cart.quote', {
        memberId: member,
        tier: 'tourist',
        lines: [{ id: lineId, packageId: PACKAGE, kids: 2, adults: 0, lineTotalSatang: 2 * 25000 }],
      }),
    ),
    (err: unknown) => err instanceof BridgeError && err.code === 'SALE_LINE_PRICE_MISMATCH',
  );
  r.t.close();
});

test('what the capability list refuses on the box lane says why; money with nowhere to write it is refused politely', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const refused = async (type: string, code: string, status = 409) =>
    assert.rejects(
      r.bridge.intent(STATION_ID, caller, intent(type, {})),
      (err: unknown) => err instanceof BridgeError && err.code === code && err.status === status,
      `${type} is refused as ${code}`,
    );
  // Plan §2.8's refusals, in its reasons (`BOX_LANE_REFUSALS`).
  await refused('sale.refund', 'BOX_LANE_REFUND_REFUSED');
  await refused('sale.void', 'BOX_LANE_REFUND_REFUSED');
  // S2-14a round 4: credit IS spent on the box lane now, under the offline cap
  // (`offline-wallet.test.ts`) — and like closing a sale it needs its permission.
  await refused('payment.wallet', 'FORBIDDEN', 403);
  await refused('payment.voucher', 'VOUCHER_NEEDS_INTERNET');
  await refused('payment.2c2p', 'BOX_LANE_2C2P_QR_REFUSED');
  // S2-12 round 5: a booking is redeemed on the box lane from the box's own
  // copy, and like closing a sale online it needs its permission.
  await refused('booking.redeem', 'FORBIDDEN', 403);
  // A money intent this box does not know yet: the round-3 sentence, not `unknown_intent`.
  await refused('sale.split_bill', 'BOX_LANE_PAYMENT_UNAVAILABLE');
  // Closing a sale needs what closing one online needs.
  await refused('sale.finalise', 'FORBIDDEN', 403);
  r.t.close();
});
test('with no signing key here, a record is refused by name rather than queued unsigned', async () => {
  const r = await rig({ seal: false });
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('member.create', {
        memberId: '018f0000-0000-7000-8000-00000000d004',
        phone: '+66813334444',
        nickname: 'N',
      }),
    ),
    (err: unknown) => err instanceof BridgeError && err.code === 'BOX_AGENT_ELSEWHERE',
  );
  assert.deepEqual(await r.t.store.allOverlay(BOX_ID), [], 'nothing half-written');
  r.t.close();
});

test('the overlay is pruned once its fact is accepted and a later members pull holds the record', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const memberId = '018f0000-0000-7000-8000-00000000d005';
  await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.create', { memberId, phone: '+66815556666', nickname: 'Soon synced' }),
  );
  assert.equal(await r.bridge.pruneOverlay(), 0, 'not yet accepted: kept');

  const batch = await r.t.store.takeBatch(BOX_ID);
  r.now.at = new Date(Date.parse(T0) + 60_000);
  r.t.setNow(r.now.at.toISOString());
  await r.t.store.settle(
    BOX_ID,
    batch.events.map((e) => ({ eventId: e.eventId, boxSeq: e.boxSeq, result: 'applied' as const })),
    {
      sent: batch.events.map((e) => e.eventId),
      cursorSeq: batch.events.at(-1)!.boxSeq,
      now: r.now.at.toISOString(),
      retryAt: () => r.now.at.toISOString(),
    },
  );
  assert.equal(
    await r.bridge.pruneOverlay(),
    0,
    'accepted, but the cache is older than the acceptance',
  );
  r.now.at = new Date(Date.parse(T0) + 120_000);
  await r.write('members', [
    {
      id: memberId,
      phone: '+66815556666',
      nickname: 'Soon synced',
      tierCode: 'tourist',
      aliasIds: [],
      children: [],
    },
  ]);
  assert.equal(await r.bridge.pruneOverlay(), 1);
  assert.equal((await r.bridge.lookup(STATION_ID, caller, '+66815556666'))?.source, 'cache');
  r.t.close();
});

test('OD-11: a tier upgraded on a document at the counter prices the next cart; a downgrade needs its own permission', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const memberId = '018f0000-0000-7000-8000-00000000d006';
  await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.create', { memberId, phone: '+66817778888', nickname: 'Resident' }),
  );
  // SCRUM-498: a tier the member is not verified for prices nothing, as the
  // platform's `resolveTier` decides it: the member's own rate stands, and a
  // till that priced the line at the other rate is refused before any money.
  const unverifiedLine = '018f0000-0000-7000-8000-0000000001b0';
  const asked = await r.bridge.intent(STATION_ID, caller, intent('cart.quote', {
    memberId, tier: 'thai', lines: [{ id: unverifiedLine, packageId: PACKAGE, kids: 1, adults: 0 }],
  }));
  const askedQuote = asked.result?.quote as {
    tier: string;
    tierSource: string;
    lineTotals: Record<string, number>;
    disagreements: { tierDiffers: boolean };
  };
  assert.equal(askedQuote.tier, 'tourist', 'the member’s verified tier prices the cart');
  assert.equal(askedQuote.tierSource, 'member');
  assert.equal(askedQuote.lineTotals[unverifiedLine], 35000);
  assert.equal(askedQuote.disagreements.tierDiffers, true);
  await assert.rejects(
    r.bridge.intent(STATION_ID, caller, intent('cart.quote', {
      memberId, tier: 'thai', lines: [{ id: unverifiedLine, packageId: PACKAGE, kids: 1, adults: 0, lineTotalSatang: 25000 }],
    })),
    (err: unknown) => err instanceof BridgeError && err.code === 'SALE_LINE_PRICE_MISMATCH',
    'a Thai line for a member not verified as Thai is refused',
  );
  await assert.rejects(
    r.bridge.intent(STATION_ID, caller, intent('member.tier_change', {
      direction: 'upgrade', memberId,
      verificationId: '018f0000-0000-7000-8000-0000000000e6',
      toTier: 'thai', evidenceType: 'Other',
    })),
    (err: unknown) => err instanceof BridgeError && err.status === 400,
  );
  const upgraded = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.tier_change', {
      direction: 'upgrade',
      memberId,
      verificationId: '018f0000-0000-7000-8000-0000000000e7',
      toTier: 'thai',
      evidenceType: 'Residence certificate',
      evidenceExpiresAt: '2027-09-30',
    }),
  );
  assert.equal((upgraded.result?.member as { tierCode: string }).tierCode, 'thai');
  const lineId = '018f0000-0000-7000-8000-0000000001b1';
  const priced = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('cart.quote', {
      memberId,
      lines: [{ id: lineId, packageId: PACKAGE, kids: 1, adults: 0 }],
    }),
  );
  const quote = priced.result?.quote as { tier: string; lineTotals: Record<string, number> };
  assert.equal(quote.tier, 'thai');
  assert.equal(quote.lineTotals[lineId], 25000);
  const baseline = await r.bridge.intent(STATION_ID, caller, intent('cart.quote', {
    memberId, tier: 'tourist', lines: [{ id: lineId, packageId: PACKAGE, kids: 1, adults: 0 }],
  }));
  assert.equal((baseline.result?.quote as { tier: string }).tier, 'tourist', 'the default needs no proof');

  // Reception holds no `pos:member:tier_downgrade`, offline as online.
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('member.tier_change', {
        direction: 'downgrade',
        memberId,
        verificationId: '018f0000-0000-7000-8000-0000000000e8',
        reason: 'Document belonged to someone else',
      }),
    ),
    (err: unknown) => err instanceof BridgeError && err.status === 403,
  );
  const [, factTier] = (await r.t.store.takeBatch(BOX_ID)).events;
  assert.equal(factTier!.type, 'member.tier_changed');
  assert.equal(factTier!.payload.toTier, 'thai');
  assert.equal(OfflineMemberTierChangedSchema.safeParse({ ...factTier!.payload, evidenceType: 'Other' }).success, true,
    'queued verifications accepted by earlier boxes remain replayable');
  r.t.close();
});

test('OD-11: a document with no expiry date verifies a tier offline; an expired one is refused', async () => {
  const r = await rig();
  const { caller } = await r.bridge.unlock(STATION_ID, {
    token: token(r.now.at),
    password: 'open-sesame',
  });
  const memberId = '018f0000-0000-7000-8000-00000000d007';
  await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.create', { memberId, phone: '+66817779999', nickname: 'No expiry' }),
  );
  await assert.rejects(
    r.bridge.intent(
      STATION_ID,
      caller,
      intent('member.tier_change', {
        direction: 'upgrade',
        memberId,
        verificationId: '018f0000-0000-7000-8000-0000000000e9',
        toTier: 'thai',
        evidenceType: 'Residence certificate',
        evidenceExpiresAt: '2000-01-01',
      }),
    ),
    (err: unknown) => err instanceof BridgeError && err.status === 400,
  );
  const upgraded = await r.bridge.intent(
    STATION_ID,
    caller,
    intent('member.tier_change', {
      direction: 'upgrade',
      memberId,
      verificationId: '018f0000-0000-7000-8000-0000000000ea',
      toTier: 'thai',
      evidenceType: 'Residence certificate',
    }),
  );
  assert.equal((upgraded.result?.member as { tierCode: string }).tierCode, 'thai');
  const [, factTier] = (await r.t.store.takeBatch(BOX_ID)).events;
  assert.equal(factTier!.type, 'member.tier_changed');
  assert.equal(factTier!.payload.evidenceExpiresAt, undefined);
  r.t.close();
});
