import assert from 'node:assert/strict';
import { randomUUID, randomInt, createHash } from 'node:crypto';

/** One native journey, shared by the disposable rehearsal and staging. */
export async function runFlow(S) {
  const { browser, expect, origin, adminApi, enterPos, record: r, save, shot, stable, shared } = S;
  const { invoiceStationSegment, mintBoothCode } = shared;
  const f = r.fixture;
  const active = [];
  const phase = value => { r.phase = value; save(); };
  const apiFor = context => async (method, path, data) => {
    const response = await context.request.fetch(origin + '/api' + path, {
      method, data, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() },
    });
    const body = await response.json().catch(() => null);
    r.requests.push({ method, path: path.split('?')[0], status: response.status(), errorCode: body?.error?.code ?? null }); save();
    assert.equal(response.status(), 200, method + ' ' + path.split('?')[0] + ': ' + response.status() + ' ' + (body?.error?.code ?? ''));
    return body;
  };
  let photo;
  const uploadPhoto = async (api, family, pickup = false) => {
    const id = randomUUID();
    if (pickup) family.pickupPhotoId = id; else family.photoId = id;
    save();
    await api('POST', '/files', { id, contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: family.registrationId, filename: 'zz-test-s747.png' });
    const response = await family.context.request.put(origin + '/api/files/' + id + '/content', { data: photo, headers: { 'content-type': 'image/png' } });
    assert.ok(response.ok(), 'Synthetic photo upload failed');
    if (!pickup) await api('POST', '/checkin/registrations/' + family.registrationId + '/photo', { fileId: id, checkinIds: [family.checkinId] });
    return id;
  };
  const settle = async (api, attempt, label) => {
    assert.equal(attempt.provider, 'simulator');
    r.attempts.push({ id: attempt.id, saleId: attempt.saleId, label }); save();
    const paid = await api('POST', '/webhooks/2c2p/simulator', { attemptId: attempt.id, event: 'paid' });
    assert.equal(paid.gatewayState, 'paid');
    const detail = await api('GET', '/payments/attempts/' + attempt.id);
    assert.equal(detail.attempt.status, 'approved');
  };
  const paymentScreen = async page => {
    await page.getByRole('button', { name: /^Charge ฿/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
    await dialog.getByRole('button', { name: '7', exact: true }).click();
    await dialog.getByRole('button', { name: '4', exact: true }).click();
    await dialog.getByRole('button', { name: /^Continue to Payment/ }).click();
  };
  const setupFamily = async (entry, config, pkg) => {
    const family = { registrationId: randomUUID(), checkinId: randomUUID(), saleId: randomUUID(), name: f.name + ' child ' + entry.length };
    entry.family = family; save();
    // The browser context is kept only in memory, never serialized.
    Object.defineProperty(family, 'context', { value: entry.context, enumerable: false });
    const api = entry.api;
    await api('POST', '/checkin/registrations', {
      id: family.registrationId, branchId: f.branchId, stationId: entry.id,
      guardianName: f.name + ' guardian ' + entry.length, contactChannel: 'whatsapp',
      consentAcknowledged: true, acknowledgedConfirmationIds: config.policy.confirmations.map(item => item.id),
      children: [{ checkinId: family.checkinId, name: family.name, ageYears: 9, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } }],
    });
    await uploadPhoto(api, family);
    await api('POST', '/sales', { id: family.saleId, stationId: entry.id, lines: [{ id: family.checkinId, packageId: pkg.id, kids: 1, adults: 0,
      serviceFee: { label: 'ZZ TEST drop-off service', amountSatang: config.pricing.oneTimeFee.weekday }, foodProvision: { mode: 'none', paidSatang: 0 } }] });
    const tender = await api('POST', '/payments/attempts', { saleId: family.saleId, actionId: randomUUID(), tender: 'qr', method: 'promptpay', kind: 'qr' });
    await settle(api, tender.attempt, 'fixture family ' + entry.length);
    await api('POST', '/checkin/check-in-now', { saleId: family.saleId, entries: [{ checkinId: family.checkinId, nannyId: null }] });
    const registration = await api('GET', '/checkin/registrations/' + family.registrationId);
    const child = registration.children.find(item => item.id === family.checkinId);
    assert.equal(child.status, 'in_park'); family.bandId = child.bandId;
    const detail = await api('GET', '/sales/' + family.saleId);
    const band = detail.bands.find(item => item.id === family.bandId);
    assert.ok(band?.shortCode?.startsWith(entry.code + '-')); save();
    return band.shortCode;
  };
  try {
    phase('dedicated test catalogue and tills'); await stable();
    const me = await adminApi('GET', '/me'); f.branchId = me.operatorContext.branchId;
    const boxes = (await adminApi('GET', '/branches/' + f.branchId + '/boxes')).boxes;
    const virtual = boxes.find(item => item.role === 'virtual' && item.status === 'online' && !item.archived && !/FWBooth1|Pi/i.test(item.name));
    assert.ok(virtual, 'No online virtual box is available'); f.boxId = virtual.id;
    const category = await adminApi('POST', '/menu/categories', { name: f.name + ' food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen' });
    f.categoryId = category.id; save(); f.productName = f.name + ' rice';
    f.productId = (await adminApi('POST', '/branches/' + f.branchId + '/menu/products', { name: f.productName, kind: 'menu', categoryId: f.categoryId,
      priceSatang: 100, priceWeekendSatang: 100, stockLinks: [], active: true })).id; save();
    const existing = (await adminApi('GET', '/branches/' + f.branchId + '/stations?includeArchived=true')).stations;
    const codes = new Set(existing.map(item => item.codePrefix));
    const segments = new Set(existing.flatMap(item => item.codePrefix ? [invoiceStationSegment(item.codePrefix)] : []));
    const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (const length of [4, 6]) {
      let code;
      for (let i = 0; i < 10_000 && !code; i += 1) {
        const candidate = 'ZZ' + Array.from({ length: length - 2 }, () => alphabet[randomInt(alphabet.length)]).join('');
        if (!codes.has(candidate) && !segments.has(invoiceStationSegment(candidate))) code = candidate;
      }
      assert.ok(code, 'No unused test code and invoice segment'); codes.add(code); segments.add(invoiceStationSegment(code));
      const entry = { length, code, name: f.name + ' till ' + length, id: randomUUID() }; f.stations.push(entry); save();
      const made = await adminApi('POST', '/branches/' + f.branchId + '/stations', { id: entry.id, name: entry.name, boxId: f.boxId,
        kind: 'till', codePrefix: code, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'gateway' }, devices: [] });
      assert.equal(made.station.id, entry.id); assert.equal(made.station.ready, true); save();
    }
    const photoPage = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await photoPage.setContent('<body style="background:#163345;color:white;font:30px sans-serif;padding:90px">ZZ TEST SCRUM-747<br>Synthetic image<br>No person photographed</body>');
    photo = await photoPage.screenshot(); await photoPage.close();
    for (const entry of f.stations) {
      phase('native ' + entry.length + '-character till'); await stable();
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } }); context.setDefaultTimeout(25_000);
      const page = await context.newPage(), api = apiFor(context);
      Object.defineProperties(entry, { context: { value: context, enumerable: false }, api: { value: api, enumerable: false }, page: { value: page, enumerable: false } });
      active.push(entry);
      await enterPos(context, page);
      await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible();
      await page.getByRole('button', { name: new RegExp(entry.name) }).click();
      await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
      const config = await api('GET', '/checkin/config?branchId=' + f.branchId);
      const pkg = (await api('GET', '/branches/' + f.branchId + '/ticket-packages')).packages.find(item => item.name === '2 Hours Play' && item.active && !item.archivedAt);
      assert.ok(pkg); const shortCode = await setupFamily(entry, config, pkg);
      await page.goto(origin + '/order-station');
      await page.getByPlaceholder('Wristband code e.g. 1001').fill(shortCode);
      await page.getByRole('button', { name: 'Load Tab', exact: true }).click();
      await expect(page.getByText(entry.family.name, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/Invalid code/)).toHaveCount(0);
      await shot('s746-band-' + entry.length + '-character-till', page);
      r.cases.push({ name: 'typed band opens its child', stationLength: entry.length, childId: entry.family.checkinId, passed: true }); save();
      await page.goto(origin + '/order-station');
      await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
      await page.getByPlaceholder('Search dish…').fill(f.productName);
      await page.getByRole('button', { name: new RegExp(f.productName) }).click();
      const modifier = page.getByRole('dialog');
      if (await modifier.getByRole('button', { name: /^Add to order/ }).isVisible()) await modifier.getByRole('button', { name: /^Add to order/ }).click();
      await paymentScreen(page);
      await page.getByRole('button', { name: 'PromptPay', exact: true }).click();
      const opened = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/payments/attempts');
      await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
      const response = await opened; assert.equal(response.status(), 200, 'Native gateway QR request');
      const tender = await response.json(); assert.equal(tender.attempt.provider, 'simulator');
      entry.fnbSaleId = tender.attempt.saleId; save();
      assert.match(tender.attempt.invoiceNo, /^[A-Z0-9]{1,20}$/);
      await expect(page.getByTestId('payment-qr').first()).toBeVisible();
      await shot('s747-gateway-qr-' + entry.length + '-character-till', page);
      await settle(api, tender.attempt, 'native F&B ' + entry.length);
      await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
      r.cases.push({ name: 'native QR appears and simulator completes once', stationLength: entry.length, saleId: entry.fnbSaleId, attemptId: tender.attempt.id, passed: true }); save();
    }
    phase('genuine voucher typed into F&B'); await stable();
    const last = active.at(-1), api = last.api, page = last.page;
    const voucherCode = mintBoothCode('ZZ', maximum => randomInt(max));
    f.voucherCodeFingerprint = createHash('sha256').update(voucherCode).digest('hex');
    const definition = await adminApi('POST', '/voucher-definitions', { code: 'zz-test-s747-' + f.stamp,
      nameEn: f.name + ' voucher', kind: 'free_item', productId: f.productId, codeMode: 'fixed', fixedCode: voucherCode,
      active: true, singleUse: true, usageLimit: 1, expiryDays: 1, offlinePolicy: 'refuse', costSatang: 0 });
    f.voucherDefinitionId = definition.id ?? definition.definition?.id; assert.ok(f.voucherDefinitionId); save();
    await page.goto(origin + '/order-station');
    await page.getByPlaceholder('Wristband code e.g. 1001').fill(voucherCode);
    const held = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/sales\/[^/]+\/vouchers$/.test(new URL(response.url()).pathname));
    await page.getByRole('button', { name: 'Load Tab', exact: true }).click();
    const hold = await held; assert.equal(hold.status(), 200, 'The genuine voucher is held');
    const heldBody = await hold.json();
    f.voucherId = heldBody.voucher?.id ?? heldBody.id; f.voucherCartId = new URL(hold.url()).pathname.split('/')[3]; save();
    await expect(page.getByRole('button', { name: 'Remove voucher', exact: true })).toBeVisible();
    await expect(page.getByText(/Invalid code/)).toHaveCount(0);
    await shot('s746-genuine-voucher-opens-order', page);
    await paymentScreen(page);
    await page.getByRole('button', { name: 'Complete Order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
    const voucherSale = await api('GET', '/sales/' + f.voucherCartId);
    assert.equal(voucherSale.sale.status, 'finalised'); assert.equal(voucherSale.sale.totals.grossSatang, 0);
    r.cases.push({ name: 'genuine voucher opens its order and redeems once', saleId: f.voucherCartId, passed: true }); save();
    r.nativePassedAt = new Date().toISOString(); r.outcome = 'native journeys passed; cleanup follows'; save();
  } catch (error) {
    r.failure = { phase: r.phase, name: error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[address omitted]').slice(0, 250) };
    save(); for (const entry of active) await shot('failure-' + entry.length, entry.page).catch(() => {});
  } finally {
    phase('exact test cleanup'); r.cleanup = { errors: [], children: [], stations: [], sessions: [] }; save();
    const cleanup = async (step, run) => { try { await run(); } catch (error) { r.cleanup.errors.push({ step, name: error.name, message: String(error.message).split('\n')[0].slice(0, 180) }); save(); } };
    for (const entry of active) {
      const api = entry.api;
      await cleanup('own pending payments ' + entry.length, async () => {
        for (const attempt of r.attempts.filter(item => [entry.family?.saleId, entry.fnbSaleId].includes(item.saleId))) {
          const read = await api('GET', '/payments/attempts/' + attempt.id); assert.equal(read.attempt.provider, 'simulator');
          if (['created', 'sent_to_terminal'].includes(read.attempt.status)) await api('POST', '/payments/attempts/' + attempt.id + '/cancel', { reason: 'ZZ TEST SCRUM-747 cleanup' });
        }
      });
      if (entry.family) await cleanup('release own child ' + entry.length, async () => {
        const family = entry.family;
        const read = await api('GET', '/checkin/registrations/' + family.registrationId);
        assert.equal(read.guardianName, f.name + ' guardian ' + entry.length);
        const child = read.children.find(item => item.id === family.checkinId); assert.equal(child.name, family.name);
        if (child.status === 'in_park') {
          const photoId = await uploadPhoto(api, family, true);
          await api('POST', '/checkin/pickups/stays/' + family.checkinId + '/release', { id: randomUUID(), collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId, stationId: entry.id });
        }
        const after = await api('GET', '/checkin/registrations/' + family.registrationId);
        assert.equal(after.children.find(item => item.id === family.checkinId).status, 'out');
        r.cleanup.children.push({ id: family.checkinId, status: 'out' }); save();
      });
      await cleanup('end own POS session ' + entry.length, async () => {
        const doc = (await adminApi('GET', '/stations/' + entry.id + '/session')).document;
        const logout = await entry.context.request.post(origin + '/api/auth/sign-out', { data: doc.lease?.leaseId ? { stationLeaseId: doc.lease.leaseId } : {} });
        assert.equal(logout.status(), 200); assert.equal((await entry.context.request.get(origin + '/api/me')).status(), 401);
        r.cleanup.sessions.push({ stationId: entry.id, ended: true }); save();
      });
    }
    if (f.voucherDefinitionId) await cleanup('retire own voucher definition', async () => {
      await adminApi('DELETE', '/voucher-definitions/' + f.voucherDefinitionId);
      const defs = await adminApi('GET', '/voucher-definitions?includeArchived=true');
      const own = (defs.definitions ?? defs).find(item => item.id === f.voucherDefinitionId);
      assert.ok(own?.archivedAt || own?.archived); r.cleanup.voucherDefinitionArchived = true;
    });
    for (const entry of f.stations) await cleanup('retire own station ' + entry.length, async () => {
      const current = (await adminApi('GET', '/stations/' + entry.id)).station; assert.equal(current.name, entry.name); assert.equal(current.boxId, f.boxId);
      await adminApi('DELETE', '/stations/' + entry.id);
      const list = (await adminApi('GET', '/branches/' + f.branchId + '/stations?includeArchived=true')).stations;
      assert.equal(list.find(item => item.id === entry.id).archived, true);
      r.cleanup.stations.push({ id: entry.id, archived: true }); save();
    });
    if (f.productId) await cleanup('retire own product', async () => { await adminApi('DELETE', '/branches/' + f.branchId + '/menu/products/' + f.productId); r.cleanup.productArchived = true; });
    if (f.categoryId) await cleanup('retire own category', async () => { await adminApi('DELETE', '/menu/categories/' + f.categoryId); r.cleanup.categoryArchived = true; });
    if (f.productId) await cleanup('read back catalogue retirement', async () => {
      const menu = await adminApi('GET', '/branches/' + f.branchId + '/menu');
      assert.ok(!menu.products.some(item => item.id === f.productId && item.active && !item.archivedAt));
      assert.ok(!menu.categories.some(item => item.id === f.categoryId && item.active && !item.archivedAt)); r.cleanup.catalogueReadBack = true;
    });
    for (const entry of active) await entry.context.close();
    r.cleanup.finishedAt = new Date().toISOString(); r.cleanup.passed = r.cleanup.errors.length === 0 && r.cleanup.children.length === 2;
    r.outcome = !r.failure && r.cleanup.passed ? 'native journeys and canonical cleanup passed' : 'incomplete'; save();
  }
}
