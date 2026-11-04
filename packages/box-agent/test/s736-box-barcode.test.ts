import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoxAgent, type BoxConfigCache } from '../src/agent';
import type { StationScanMessage } from '../src/contract';
import { memoryCredentialStore } from '../src/credentials';
import { PRODUCT_BARCODE_HANDLER, UNKNOWN_BARCODE } from '../src/scan';
import { resolveCataloguedBarcode } from '../src/product-barcode-cache';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestAgent, openTestStore, tillBundle } from './_support';

const SOCKS = '018f0000-0000-7000-8000-00000000a001';
const TEE = '018f0000-0000-7000-8000-00000000a002';
const OLD_TEE = '018f0000-0000-7000-8000-00000000a003';
const LATTE = '018f0000-0000-7000-8000-00000000a004';

/** The catalogue scope as `catalogueCacheItem` ships it: whole product rows, dates as ISO strings. */
function catalogue(): Record<string, unknown> {
  return {
    items: [
      {
        version: 'zz-test-catalogue',
        products: [
          { id: SOCKS, kind: 'merch', name: 'Grip Socks', sku: '8850000000017', variants: [], priceSatang: 9_000, priceWeekendSatang: null, categoryId: null, branchId: null, active: true, archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z' },
          { id: TEE, kind: 'merch', name: 'ZZ Tee', sku: null, variants: [{ id: 'm', label: 'M', barcode: '8850000000024' }], priceSatang: 35_000, priceWeekendSatang: 39_000, categoryId: null, branchId: null, active: false, archivedAt: null, createdAt: '2026-10-03T00:00:00.000Z' },
          { id: OLD_TEE, kind: 'merch', name: 'ZZ Old Tee', sku: null, variants: [{ id: 'l', label: 'L', barcode: '8850000000024' }], priceSatang: 30_000, priceWeekendSatang: null, categoryId: null, branchId: null, active: true, archivedAt: null, createdAt: '2026-10-02T00:00:00.000Z' },
          { id: LATTE, kind: 'menu', name: 'Latte', sku: '8850000000031', variants: [], priceSatang: 8_000, priceWeekendSatang: null, categoryId: null, branchId: null, active: true, archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z' },
        ],
      },
    ],
  };
}

test('SCRUM-736: a cached catalogue resolves a barcode as the api does', () => {
  const whole = resolveCataloguedBarcode(catalogue(), '8850000000017');
  assert.deepEqual(whole, {
    productId: SOCKS, name: 'Grip Socks', sku: '8850000000017', priceSatang: 9_000,
    priceWeekendSatang: null, categoryId: null, branchId: null, variant: null,
  });
  const sized = resolveCataloguedBarcode(catalogue(), '8850000000024');
  assert.equal(sized?.productId, OLD_TEE, 'two sizes carrying one code: the older row answers');
  assert.deepEqual(sized?.variant, { id: 'l', label: 'L' });
  assert.equal(sized?.sku, '8850000000024');
  assert.equal(resolveCataloguedBarcode(catalogue(), '8850000000031'), null, 'a menu item is never added by a label');
  assert.equal(resolveCataloguedBarcode(catalogue(), '8850000000099'), null);
  assert.equal(resolveCataloguedBarcode(null, '8850000000017'), null, 'no copy yet reads as unknown');
});

test('SCRUM-736: a Pi resolves a cradle barcode online and offline, one identity on both paths', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const normal = cloud.fetch;
  const relayed: StationScanMessage[] = [];
  let blocked = false;
  cloud.fetch = (url, init) => {
    if (blocked) return Promise.reject(new Error('platform unreachable'));
    if (url.endsWith('/box/v1/scans')) {
      relayed.push((JSON.parse(init.body!) as { scan: StationScanMessage }).scan);
      return Promise.resolve({ status: 204, json: async () => null, text: async () => '', header: () => null });
    }
    return normal(url, init);
  };
  const held = await openTestAgent(cloud, { productBarcodes: { enabled: true } });
  await held.harness.store.writeBundle(BOX_ID, {
    scope: 'catalogue', schemaVersion: 1, cursorSeq: 0, payload: catalogue(), appliedAt: new Date().toISOString(),
  });
  const local: StationScanMessage[] = [];
  const stop = held.agent.sessions()!.subscribe(STATION_ID, 'staff', (message) => {
    if (message.kind === 'scan') local.push(message);
  });
  try {
    assert.ok(held.agent.scanner()!.registered().includes(PRODUCT_BARCODE_HANDLER));
    await held.agent.scanner()!.deliver(STATION_ID, { code: '8850000000017', source: 'box_hid' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(local.length, 1);
    const online = local[0]!;
    assert.equal(online.codeKind, 'product');
    assert.equal(online.outcome, 'handled');
    assert.equal(online.handler, PRODUCT_BARCODE_HANDLER);
    assert.deepEqual((online.detail?.add as { productId?: unknown }).productId, SOCKS);
    assert.deepEqual(relayed, [online], 'the platform copy is the same answer under the same scanId');

    blocked = true;
    await held.agent.syncConfig().catch(() => undefined);
    assert.equal(held.agent.state.linkUp, false);
    await held.agent.scanner()!.deliver(STATION_ID, { code: '8850000000024', source: 'box_serial' });
    await held.agent.scanner()!.deliver(STATION_ID, { code: '8850000000099', source: 'box_serial' });
    assert.equal(local.length, 3);
    assert.equal(local[1]!.outcome, 'handled');
    assert.deepEqual((local[1]!.detail?.add as { variant?: unknown }).variant, { id: 'l', label: 'L' });
    assert.equal(local[2]!.outcome, 'refused');
    assert.equal(local[2]!.errorCode, UNKNOWN_BARCODE);
    assert.equal(relayed.length, 1, 'nothing is relayed with the link down');
  } finally {
    stop();
    held.close();
  }
});

test('SCRUM-736: the cached lookup is a Pi default and stays off where the api registers its own', async () => {
  const virtual = await openTestAgent(fakeBoxCloud(tillBundle()));
  try {
    assert.equal(virtual.agent.scanner()!.registered().includes(PRODUCT_BARCODE_HANDLER), false);
  } finally {
    virtual.close();
  }

  const harness = openTestStore();
  await harness.store.init(BOX_ID);
  let held: Awaited<ReturnType<BoxConfigCache['read']>> = null;
  const configCache: BoxConfigCache = {
    read: async () => held,
    write: async (bundle) => { held = bundle; },
  };
  const pi = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID, secret: 'till-box-test-secret', syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: fakeBoxCloud(tillBundle()).fetch,
    log: { info() {}, warn() {}, error() {} },
    store: harness.store,
    configCache,
    scanners: { enabled: false },
    gate: { enabled: false },
    terminal: { enabled: false },
    booth: { enabled: false },
    printing: { retryDelayMs: 0 },
  });
  try {
    await pi.ensureRegistered();
    await pi.syncConfig();
    assert.ok(pi.scanner()!.registered().includes(PRODUCT_BARCODE_HANDLER));
  } finally {
    pi.stop();
    harness.close();
  }
});
