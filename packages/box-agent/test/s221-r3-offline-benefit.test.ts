import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import {
  BENEFIT_CREDENTIAL_REFUSALS,
  OfflineBenefitRecordSchema,
  PRICING_ENGINE_VERSION,
  type BenefitScopeItem,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { encodeBenefitCredential } from '../src/benefit-credential';
import { memoryCredentialStore } from '../src/credentials';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * S2-21 (SCRUM-218) round 3 — a staff benefit at an F&B counter whose box has
 * the link down (plan docs/progress/plans/benefits/PLAN.md §4, H11, H12).
 *
 *   - comp and the standing percent apply on the box, from the `benefits`
 *     scope, by the engine every surface prices with;
 *   - free items and credit are "online only": named on the breakdown, never
 *     applied, nothing used up;
 *   - the sale's fact carries what the box applied and the engine version it
 *     applied it with — never the QR — so the platform can check it on replay;
 *   - a revoked QR, a box with no scope and a till's own "Staff benefit" row
 *     are refused in the counter's words, and nothing is recorded.
 */

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const kid = createHash('sha256')
    .update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    key: { purpose: 'benefit_qr', kid, algorithm: 'ed25519', publicKey: publicKeyPem },
  };
}

const PARK = keypair();
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const DRINKS = '018f0000-0000-7000-8000-0000000000d1';
const COFFEE = '018f0000-0000-7000-8000-0000000000d2';
const LATTE = '018f0000-0000-7000-8000-0000000000e1';
const HOTDOG = '018f0000-0000-7000-8000-0000000000e2';
const quiet = { info() {}, warn() {}, error() {} };
const IN_A_YEAR = Math.floor(Date.now() / 1000) + 365 * 86_400;

const person = () => ({ employeeId: uuidv7(), credentialId: uuidv7() });
const SOM = person();
const ANAN = person();
const MAY = person(); // free coffees only: nothing a box may apply
const NOK = person(); // revoked
const qr = (who: { employeeId: string; credentialId: string }) =>
  encodeBenefitCredential({ ...who, exp: IN_A_YEAR }, { kid: PARK.key.kid, privateKeyPem: PARK.privateKeyPem });

function benefitsItem(): BenefitScopeItem {
  const day = (over: Record<string, unknown>) => ({
    from: '2020-01-01',
    to: null,
    benefitRole: 'staff' as const,
    comp: false,
    standingDiscount: null,
    onlineOnly: [] as ('freeItems' | 'credit')[],
    ...over,
  });
  return {
    version: 'benefits-r3',
    keys: [PARK.key],
    revokedCredentialIds: [NOK.credentialId],
    revokedEmployeeIds: [],
    employees: [
      {
        employeeId: SOM.employeeId,
        name: 'Som (Reception)',
        days: [day({ standingDiscount: { percent: 30, target: { kind: 'fnb' } }, onlineOnly: ['freeItems'] })],
      },
      { employeeId: ANAN.employeeId, name: 'Khun Anan (Owner)', days: [day({ benefitRole: 'owner', comp: true })] },
      { employeeId: MAY.employeeId, name: 'May (Reception)', days: [day({ onlineOnly: ['freeItems', 'credit'] })] },
      { employeeId: NOK.employeeId, name: 'Nok (Reception)', days: [day({ standingDiscount: { percent: 30 } })] },
    ],
  };
}

function catalogueItem() {
  const product = (id: string, name: string, priceSatang: number, categoryId: string) => ({
    id,
    kind: 'menu',
    name,
    priceSatang,
    priceWeekendSatang: null,
    categoryId,
    taxCategoryOverride: null,
    prepStationOverride: null,
    variants: [],
    active: true,
    archivedAt: null,
  });
  return {
    version: 'cat-s221-r3',
    packages: [],
    categories: [
      { id: DRINKS, parentId: null, taxableCategory: 'fnb', name: 'Drinks', defaultPrepStation: 'bar' },
      { id: COFFEE, parentId: DRINKS, taxableCategory: null, name: 'Coffee', defaultPrepStation: null },
    ],
    products: [product(LATTE, 'Latte', 9_500, COFFEE), product(HOTDOG, 'Hot dog', 8_000, DRINKS)],
    modifierGroups: [],
    modifierOptions: [],
    modifierLinks: [],
    tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
    holidays: [],
    taxConfig: {
      config: {
        rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
        categoryRules: [{ category: 'fnb', taxRateId: 'vat', taxMode: 'inclusive' }],
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

interface BenefitBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  till: BridgeTillCaller;
  write(scope: CachedBundle['scope'], items: unknown[]): Promise<void>;
  close(): void;
}

async function openBenefitBox(opts: { scope?: boolean } = {}): Promise<BenefitBox> {
  const cloud = fakeBoxCloud(tillBundle());
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 's221-r3-benefit-test-secret',
      syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { retryDelayMs: 0, durable: true },
    booth: { enabled: false },
    terminal: { enabled: false },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    await harness.store.writeBundle(BOX_ID, {
      scope,
      schemaVersion: 1,
      cursorSeq: 0,
      payload: { items },
      appliedAt: new Date().toISOString(),
    });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 7 }]);
  if (opts.scope !== false) await write('benefits', [benefitsItem()]);
  const till: BridgeTillCaller = {
    kind: 'till',
    accountId: ACCOUNT,
    can: () => true,
    method: 'offline_token',
    offlineFresh: false,
    jti: null,
  };
  return {
    agent,
    harness,
    bridge: agent.bridge()!,
    till,
    write,
    close() {
      agent.stop();
      harness.close();
    },
  };
}

async function ask(box: BenefitBox, type: string, payload: Record<string, unknown>, caller = box.till) {
  const answer = await box.bridge.intent(STATION_ID, caller, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `t-${uuidv7().slice(-12)}`,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
  return answer.result as Record<string, any>;
}

async function refusal(run: Promise<unknown>): Promise<BridgeError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof BridgeError) return err;
    throw err;
  }
  assert.fail('expected a refusal');
}

const itemLine = (productId: string, quantity = 1) => ({ id: uuidv7(), productId, quantity });
const benefitOf = (who: { employeeId: string; credentialId: string }) => ({
  applicationId: uuidv7(),
  code: qr(who),
});

async function sell(box: BenefitBox, cart: Record<string, unknown>) {
  const body = { channel: 'fnb', pickupCode: '12', ...cart };
  const quote = (await ask(box, 'cart.quote', body)).quote;
  const gross = quote.totals.grossSatang as number;
  const saleId = uuidv7();
  const answer = await ask(box, 'sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    cart: { ...body, expectedTotalSatang: gross },
    ...(gross > 0
      ? {
          tender: {
            actionId: `cash-${saleId.slice(-8)}`,
            method: 'cash',
            kind: 'cash',
            amountSatang: gross,
            tenderedSatang: gross,
          },
        }
      : {}),
  });
  return { saleId, quote, gross, answer };
}

async function factOf(box: BenefitBox, saleId: string) {
  const batch = await box.harness.store.takeBatch(BOX_ID, {
    maxEvents: 50,
    maxBytes: 2_000_000,
    now: new Date().toISOString(),
  });
  const event = batch.events.find(
    (e) => e.type === 'sale.finalised' && (e.payload as { saleId?: string }).saleId === saleId,
  )!;
  return { payload: event.payload as { cart: Record<string, unknown> }, raw: JSON.stringify(event) };
}

test('s221-r3 — offline, the standing percent applies and the free coffee is online only, nothing used', async () => {
  const box = await openBenefitBox();
  try {
    const benefit = benefitOf(SOM);
    // A latte (฿95, a coffee) and a hot dog (฿80): online the latte would be a
    // free coffee; here it is 30 % off like the rest, and the free coffee says
    // "online only".
    const { saleId, quote, gross, answer } = await sell(box, {
      items: [itemLine(LATTE), itemLine(HOTDOG)],
      benefit,
    });
    assert.deepEqual(
      {
        name: quote.benefit.name,
        isComp: quote.benefit.isComp,
        freeItemsSatang: quote.benefit.freeItemsSatang,
        creditSatang: quote.benefit.creditSatang,
        discountSatang: quote.benefit.discountSatang,
        onlineOnly: quote.benefit.onlineOnly,
        source: quote.benefit.source,
        engineVersion: quote.benefit.engineVersion,
      },
      {
        name: 'Som (Reception)',
        isComp: false,
        freeItemsSatang: 0,
        creditSatang: 0,
        discountSatang: 2_900 + 2_400,
        onlineOnly: ['freeItems'],
        source: 'box',
        engineVersion: PRICING_ENGINE_VERSION,
      },
    );
    assert.equal(gross, 17_500 - 5_300);
    assert.equal(answer.finalised, true);

    const { payload, raw } = await factOf(box, saleId);
    const record = OfflineBenefitRecordSchema.parse(payload.cart.benefit);
    assert.equal(record.applicationId, benefit.applicationId);
    assert.equal(record.employeeId, SOM.employeeId);
    assert.equal(record.credentialId, SOM.credentialId);
    assert.equal(record.discountSatang, 5_300);
    assert.equal(record.totalReliefSatang, 5_300);
    assert.deepEqual(record.onlineOnly, ['freeItems']);
    assert.equal(record.engineVersion, PRICING_ENGINE_VERSION);
    // The QR stops at the box: not in the fact, not even its signature.
    const signature = benefit.code.slice(benefit.code.lastIndexOf('.') + 1);
    assert.equal(raw.includes(signature.slice(0, 24)), false);
    assert.equal(raw.includes('OTO-BEN:'), false);
    // The row is the platform's to build on replay: the till's discounts are its own.
    assert.deepEqual(payload.cart.manualDiscounts ?? [], []);
  } finally {
    box.close();
  }
});

test('s221-r3 — offline, an owner’s comp takes the order to ฿0 and closes with no tender', async () => {
  const box = await openBenefitBox();
  try {
    const { saleId, quote, gross, answer } = await sell(box, {
      items: [itemLine(LATTE, 2), itemLine(HOTDOG)],
      benefit: benefitOf(ANAN),
    });
    assert.equal(quote.benefit.isComp, true);
    assert.equal(quote.benefit.compedSatang, 27_000);
    assert.equal(gross, 0);
    assert.equal(answer.finalised, true);
    const { payload } = await factOf(box, saleId);
    const record = OfflineBenefitRecordSchema.parse(payload.cart.benefit);
    assert.equal(record.isComp, true);
    assert.equal(record.compedSatang, 27_000);
  } finally {
    box.close();
  }
});

test('s221-r3 — offline, free items and credit alone apply nothing and record nothing: “online only”', async () => {
  const box = await openBenefitBox();
  try {
    const { saleId, quote, gross } = await sell(box, { items: [itemLine(LATTE)], benefit: benefitOf(MAY) });
    assert.equal(quote.benefit.totalReliefSatang, 0);
    assert.deepEqual(quote.benefit.onlineOnly, ['freeItems', 'credit']);
    assert.equal(gross, 9_500);
    const { payload } = await factOf(box, saleId);
    assert.equal(payload.cart.benefit, undefined, 'no relief, no application: nothing to file');
  } finally {
    box.close();
  }
});

test('s221-r3 — offline, a revoked QR, a box with no list and a till’s own "Staff benefit" row are refused', async () => {
  const box = await openBenefitBox();
  try {
    const revoked = await refusal(
      ask(box, 'cart.quote', { channel: 'fnb', items: [itemLine(HOTDOG)], benefit: benefitOf(NOK) }),
    );
    assert.equal(revoked.code, BENEFIT_CREDENTIAL_REFUSALS.REVOKED);
    assert.match(revoked.message, /^Benefit revoked/);

    const forged = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        items: [itemLine(HOTDOG)],
        manualDiscounts: [{ id: uuidv7(), scope: 'order', type: 'comp', value: 0, reason: 'Staff benefit' }],
      }),
    );
    assert.equal(forged.code, 'BENEFIT_DISCOUNT_UNLINKED');

    // Read as it prints: a zero-width space does not hide the reason.
    const hidden = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        items: [itemLine(HOTDOG)],
        manualDiscounts: [{ id: uuidv7(), scope: 'order', type: 'comp', value: 0, reason: 'Staff benefit​' }],
      }),
    );
    assert.equal(hidden.code, 'BENEFIT_DISCOUNT_UNLINKED');

    // A manual discount carrying the scan's own id: refused by name, not by the engine's duplicate id.
    const scan = benefitOf(SOM);
    const twin = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        items: [itemLine(HOTDOG)],
        benefit: scan,
        manualDiscounts: [{ id: scan.applicationId, scope: 'order', type: 'fixed', value: 10, reason: 'Service recovery' }],
      }),
    );
    assert.equal(twin.code, 'BENEFIT_DISCOUNT_UNLINKED');

    const notFood = await refusal(
      ask(box, 'cart.quote', { channel: 'shop', items: [itemLine(HOTDOG)], benefit: benefitOf(SOM) }),
    );
    assert.equal(notFood.code, 'BENEFIT_FNB_ONLY');

    const noRight: BridgeTillCaller = { ...box.till, can: (p: string) => p !== 'pos:benefit:apply' };
    const quoted = await refusal(
      ask(box, 'cart.quote', { channel: 'fnb', items: [itemLine(HOTDOG)], benefit: benefitOf(SOM) }, noRight),
    );
    assert.equal(quoted.code, 'FORBIDDEN', 'pricing a benefit is applying one');
    const saleId = uuidv7();
    const refused = await refusal(
      ask(
        box,
        'sale.finalise',
        {
          saleId,
          actionId: 'pay-no-right',
          cart: { channel: 'fnb', pickupCode: '13', items: [itemLine(HOTDOG)], benefit: benefitOf(SOM), expectedTotalSatang: 5_600 },
          tender: { actionId: 'cash-no-right', method: 'cash', kind: 'cash', amountSatang: 5_600 },
        },
        noRight,
      ),
    );
    assert.equal(refused.code, 'FORBIDDEN');
  } finally {
    box.close();
  }

  const bare = await openBenefitBox({ scope: false });
  try {
    const unknown = await refusal(
      ask(bare, 'cart.quote', { channel: 'fnb', items: [itemLine(HOTDOG)], benefit: benefitOf(SOM) }),
    );
    assert.equal(unknown.code, BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN);
    assert.equal(unknown.status, 503);
  } finally {
    bare.close();
  }
});
